import type { CommitDetail, CommitDetailFile, CommitStepLink } from '../board/commitContext.js';
import type { IncomingCommitsReport, IncomingRepoView, NewsPullRequest, NewsRepo, PullRequestState, RecentCommits } from '../plan/whatsNew.js';
import { plainText } from '../../lib/plainText.js';
import {
  commitKey,
  composeCommitList,
  sameCommit,
  type CommitListGroup,
  type CommitRef,
  type CommitSequence,
  type SequenceCommit,
} from './commitsMode.js';

export interface CommitSectionGroup {
  id: string;
  kind: 'direct' | 'unassigned-pr' | 'pr' | 'on-base' | 'older';
  label: string;
  pr?: NewsPullRequest;
  commits: SequenceCommit[];
}

export interface CommitBranchGroup {
  id: string;
  repo: string;
  kind: 'incoming' | 'local' | 'detached' | 'other';
  /** Branch name (or remote ref like `origin/main` when incoming; `null` when detached or for the neutral `other` group). */
  branch: string | null;
  /** Distinct target/base branch when known and different from {@link branch}, else `null`. */
  base: string | null;
  /** Rendered heading label (`feat/x → main`, `main`, `Detached HEAD`, `origin/main`, or fallback). */
  label: string;
  /** Incoming host/status subtitle when `kind === 'incoming'`. */
  statusLabel?: string;
  /** True when `gh` PR lookup timed out on initial response and continues asynchronously. */
  prsPending?: boolean;
  /** True when the last PR refresh failed and the PRs shown are the last good ones. */
  prsStale?: boolean;
  sections: CommitSectionGroup[];
}

export interface CommitRepoGroup {
  id: string;
  repo: string;
  /** `owner/repo` only when the remote repository name differs from folder name {@link repo}, else `null`. */
  remoteRepoLabel: string | null;
  remoteRepo: string | null;
  branches: CommitBranchGroup[];
}

export type CommitTreeRow =
  | { kind: 'commit'; id: string; commit: SequenceCommit; expanded: boolean }
  | { kind: 'file'; id: string; commit: SequenceCommit; file: CommitDetailFile };

export interface CommitTreeState {
  commit: CommitRef | null;
  expanded: CommitRef | null;
  file: string | null;
  focusId: string | null;
}

export interface CommitTreeMoveResult extends CommitTreeState {
  handled: boolean;
  /** True when Enter/Space explicitly chose the focused commit or file. */
  chosen?: boolean;
}

export interface CommitStepDisplay {
  key: string;
  prefix: string | null;
  summary: string;
  checkpoint?: string;
  /** Short one-line label after "Step · ". */
  label: string;
  /** Untruncated text for native hover tooltip (`title`). */
  title: string;
  planPath?: string;
  done: boolean;
}

/** Deterministic tree node ID for a commit row. */
export const commitItemId = (ref: CommitRef): string => `commit:${commitKey(ref)}`;

/** Deterministic tree node ID for a file row under a commit. */
export const fileItemId = (ref: CommitRef, filePath: string): string => `file:${commitKey(ref)}:${filePath}`;

/** Split a repository-relative path into basename first and muted folder after. */
export function splitFilePath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { name: path, dir: '' };
  return { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

/** Single-letter git status code for file badges. */
export function statusCode(status: CommitDetailFile['status']): 'M' | 'A' | 'D' | 'R' | 'C' {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'modified':
    default:
      return 'M';
  }
}

/** First non-empty line of a commit body, for commits without recent-list prefill. */
export function firstDescriptionLine(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const line = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? line.slice(0, 300) : undefined;
}

function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace >= Math.floor(maxChars * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${trimmed}…`;
}

/** Formats a linked step into "Step · <label>" with short prefix (`RV1`, `WF2`, `RM`), step start, and checkpoint. */
export function formatCommitStepLabel(step: CommitStepLink): CommitStepDisplay {
  const plainStep = plainText(step.text);
  const plainCheckpoint = step.checkpointTitle ? plainText(step.checkpointTitle) : undefined;
  const colon = plainStep.indexOf(':');
  let prefix: string | null = null;
  let body = plainStep;
  if (colon > 0) {
    const candidate = plainStep.slice(0, colon).trim();
    const after = plainStep.slice(colon + 1).trim();
    if (candidate.length >= 1 && candidate.length <= 16 && after.length > 0 && !/^https?$/i.test(candidate)) {
      prefix = candidate;
      body = after;
    }
  }
  const summary = truncateWords(body, 44);
  const stepPart = prefix ? `${prefix}: ${summary}` : summary;
  const label = plainCheckpoint ? `${stepPart} · ${plainCheckpoint}` : stepPart;
  const title = plainCheckpoint ? `${plainStep} · ${plainCheckpoint}` : plainStep;
  return {
    key: step.key,
    prefix,
    summary,
    ...(plainCheckpoint ? { checkpoint: plainCheckpoint } : {}),
    label,
    title,
    ...(step.planPath ? { planPath: step.planPath } : {}),
    done: step.done,
  };
}

const byNewestCommit = (a: SequenceCommit, b: SequenceCommit): number => {
  const ta = a.at ? Date.parse(a.at) : Number.NaN;
  const tb = b.at ? Date.parse(b.at) : Number.NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
};

/** Returns `owner/repo` only when its final repo name differs from the local folder name `repo`. */
export function remoteRepoDisplayName(repo: string, remoteRepo: string | null | undefined): string | null {
  const trimmed = remoteRepo?.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split('/').pop() ?? trimmed;
  return leaf !== repo ? trimmed : null;
}

export function formatPrStateLabel(state: PullRequestState): 'Open' | 'Merged' | 'Closed' {
  switch (state) {
    case 'OPEN': return 'Open';
    case 'MERGED': return 'Merged';
    case 'CLOSED': return 'Closed';
  }
}

function enrichFromSources(
  c: SequenceCommit,
  recentIndex: Map<string, SequenceCommit>,
  recentRepos: Map<string, NewsRepo>,
  incomingRepos: Map<string, IncomingRepoView>,
  detail?: CommitDetail | null,
): SequenceCommit {
  const r = recentIndex.get(commitKey(c));
  const repoMeta = recentRepos.get(c.repo);
  const incMeta = incomingRepos.get(c.repo);
  const fromDetail = detail && sameCommit(detail, c) ? detail : null;
  const detailFileCount = fromDetail ? fromDetail.files.length + fromDetail.moreFiles : undefined;
  const detailFirstLine = fromDetail ? firstDescriptionLine(fromDetail.body) : undefined;
  const prNumber = c.prNumber ?? r?.prNumber ?? fromDetail?.pr?.number;
  const pr = c.pr ?? r?.pr ?? fromDetail?.pr ?? (prNumber !== undefined ? repoMeta?.pullRequests?.find((p) => p.number === prNumber) ?? null : undefined);
  const onBase = c.onBase ?? r?.onBase;
  const branch = c.branch !== undefined
    ? c.branch
    : r?.branch !== undefined
      ? r.branch
      : fromDetail?.branch !== undefined
        ? fromDetail.branch
        // The repository's current branch is evidence only for a commit that branch's own results list.
        : r ? repoMeta?.branch : undefined;
  const base = c.base !== undefined ? c.base : (r?.base !== undefined ? r.base : (r ? repoMeta?.base : undefined));
  const remoteRepo = c.remoteRepo ?? r?.remoteRepo ?? repoMeta?.remoteRepo ?? incMeta?.remoteRepo;
  return {
    repo: c.repo,
    sha: c.sha,
    subject: c.subject ?? r?.subject ?? fromDetail?.subject,
    author: c.author ?? r?.author ?? fromDetail?.author,
    at: c.at ?? r?.at ?? fromDetail?.at,
    firstBodyLine: c.firstBodyLine ?? r?.firstBodyLine ?? detailFirstLine,
    fileCount: c.fileCount ?? r?.fileCount ?? detailFileCount,
    pushed: c.pushed ?? r?.pushed ?? fromDetail?.pushed,
    ...(c.incoming ? { incoming: true } : {}),
    ...(c.host !== undefined ? { host: c.host } : {}),
    ...(c.webUrl !== undefined ? { webUrl: c.webUrl } : {}),
    ...(c.ref !== undefined ? { ref: c.ref } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(onBase ? { onBase: true as const } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(remoteRepo !== undefined ? { remoteRepo } : {}),
  };
}

/**
 * Groups Review's Commits list hierarchically by Repository → Branch → Pull request:
 * - Incoming commits (not yet in local HEAD) appear under their remote ref (`origin/main`) inside their repo.
 * - Local branch commits appear under `<branch> → <base>`, `<branch>`, or `Detached HEAD`.
 * - When PRs exist on the branch, un-PR'd commits on the branch appear first under `Not in a pull request yet`,
 *   followed by PR groups, followed by any `Already on <base>` commits merged from base.
 */
export function buildCommitRepoGroups(
  held: CommitSequence | null,
  recent: RecentCommits | undefined,
  current: CommitRef | null,
  detail?: CommitDetail | null,
  incomingReport?: IncomingCommitsReport,
): CommitRepoGroup[] {
  const recentRepos = new Map<string, NewsRepo>();
  const recentIndex = new Map<string, SequenceCommit>();
  for (const repoEntry of recent?.commits ?? []) {
    recentRepos.set(repoEntry.repo, repoEntry);
    const prByNumber = new Map((repoEntry.pullRequests ?? []).map((p) => [p.number, p]));
    for (const c of repoEntry.commits) {
      const ref: SequenceCommit = {
        repo: repoEntry.repo,
        sha: c.sha,
        subject: c.subject,
        author: c.author,
        at: c.at,
        ...(c.firstBodyLine !== undefined ? { firstBodyLine: c.firstBodyLine } : {}),
        ...(c.fileCount !== undefined ? { fileCount: c.fileCount } : {}),
        ...(c.pushed !== undefined ? { pushed: c.pushed } : {}),
        ...(c.prNumber !== undefined ? { prNumber: c.prNumber, pr: prByNumber.get(c.prNumber) ?? null } : {}),
        ...(c.onBase ? { onBase: true as const } : {}),
        ...(repoEntry.branch !== undefined ? { branch: repoEntry.branch } : {}),
        ...(repoEntry.base !== undefined ? { base: repoEntry.base } : {}),
        ...(repoEntry.remoteRepo !== undefined ? { remoteRepo: repoEntry.remoteRepo } : {}),
      };
      const k = commitKey(ref);
      if (!recentIndex.has(k)) recentIndex.set(k, ref);
    }
  }

  const incomingRepos = new Map<string, IncomingRepoView>();
  for (const inc of incomingReport?.repos ?? []) {
    incomingRepos.set(inc.repo, inc);
  }

  const orderedRepos: string[] = [];
  const addRepo = (name: string | null | undefined) => {
    if (name && !orderedRepos.includes(name)) orderedRepos.push(name);
  };
  for (const c of held?.commits ?? []) addRepo(c.repo);
  for (const r of incomingReport?.repos ?? []) {
    if (r.commits.length > 0) addRepo(r.repo);
  }
  for (const r of recent?.commits ?? []) addRepo(r.repo);
  addRepo(current?.repo);
  addRepo(detail?.repo);

  const emitted = new Set<string>();
  const heldByRepo = new Map<string, SequenceCommit[]>();
  for (const c of held?.commits ?? []) {
    const list = heldByRepo.get(c.repo);
    if (list) list.push(c);
    else heldByRepo.set(c.repo, [c]);
  }

  const repoGroups: CommitRepoGroup[] = [];
  for (const repoName of orderedRepos) {
    const recentRepo = recentRepos.get(repoName);
    const incRepo = incomingRepos.get(repoName);
    const branches: CommitBranchGroup[] = [];

    // 1. Incoming remote-tracking branch commits not yet in HEAD
    if (incRepo && incRepo.commits.length > 0) {
      const incomingItems: SequenceCommit[] = [];
      const incomingPrs = Object.entries(recentRepo?.incomingPrs ?? {});
      const prForSha = (sha: string): number | undefined => {
        const lower = sha.toLowerCase();
        return incomingPrs.find(([full]) => full.toLowerCase().startsWith(lower) || lower.startsWith(full.toLowerCase()))?.[1];
      };
      const knownPrs = new Map((recentRepo?.pullRequests ?? []).map((p) => [p.number, p]));
      for (const incomingCommit of incRepo.commits) {
        const incomingPrNumber = prForSha(incomingCommit.sha);
        const incomingPr = incomingPrNumber !== undefined ? knownPrs.get(incomingPrNumber) : undefined;
        const candidate: SequenceCommit = {
          repo: repoName,
          sha: incomingCommit.sha,
          subject: incomingCommit.subject,
          author: incomingCommit.author,
          at: incomingCommit.at,
          ...(incomingCommit.firstBodyLine !== undefined ? { firstBodyLine: incomingCommit.firstBodyLine } : {}),
          ...(incomingCommit.fileCount !== undefined ? { fileCount: incomingCommit.fileCount } : {}),
          incoming: true,
          host: incRepo.host,
          webUrl: incomingCommit.webUrl ?? null,
          ref: incomingCommit.ref ?? incRepo.ref ?? null,
          ...(incomingPr ? { prNumber: incomingPr.number, pr: incomingPr } : {}),
        };
        const key = commitKey(candidate);
        if (recentIndex.has(key) || emitted.has(key)) continue;
        emitted.add(key);
        incomingItems.push(enrichFromSources(candidate, recentIndex, recentRepos, incomingRepos, detail));
      }
      if (incomingItems.length > 0) {
        incomingItems.sort(byNewestCommit);
        const refLabel = incomingItems[0]?.ref
          ?? incRepo.ref
          ?? (incRepo.remote && incRepo.branch ? `${incRepo.remote}/${incRepo.branch}` : incRepo.branch ?? 'Remote');
        const statusLabel = incRepo.host?.name
          ? `On ${incRepo.host.name}, not in your copy yet`
          : 'Not in your copy yet';
        const incomingSections: CommitSectionGroup[] = [];
        const plain = incomingItems.filter((c) => c.prNumber === undefined || !c.pr);
        if (plain.length > 0) {
          incomingSections.push({
            id: `section:${repoName}:incoming:${refLabel}`,
            kind: 'direct',
            label: '',
            commits: plain,
          });
        }
        for (const pr of recentRepo?.pullRequests ?? []) {
          const items = incomingItems.filter((c) => c.prNumber === pr.number && c.pr);
          if (items.length === 0) continue;
          incomingSections.push({
            id: `section:${repoName}:incoming:pr:${pr.number}`,
            kind: 'pr',
            label: pr.title,
            pr,
            commits: items,
          });
        }
        branches.push({
          id: `branch:${repoName}:incoming:${refLabel}`,
          repo: repoName,
          kind: 'incoming',
          branch: refLabel,
          base: null,
          label: refLabel,
          statusLabel,
          sections: incomingSections,
        });
      }
    }

    // 2. Local branch commits (held + recent + fallback current)
    const rawLocalCandidates: SequenceCommit[] = [
      ...(heldByRepo.get(repoName) ?? []),
      ...(recentRepo?.commits ?? []).map((c): SequenceCommit => ({
        repo: repoName,
        sha: c.sha,
        subject: c.subject,
        author: c.author,
        at: c.at,
        ...(c.firstBodyLine !== undefined ? { firstBodyLine: c.firstBodyLine } : {}),
        ...(c.fileCount !== undefined ? { fileCount: c.fileCount } : {}),
        ...(c.pushed !== undefined ? { pushed: c.pushed } : {}),
        ...(c.prNumber !== undefined ? { prNumber: c.prNumber } : {}),
        ...(c.onBase ? { onBase: true as const } : {}),
      })),
    ];
    if (current && current.repo === repoName) {
      rawLocalCandidates.push({ repo: current.repo, sha: current.sha });
    }

    const localCommits: SequenceCommit[] = [];
    for (const candidate of rawLocalCandidates) {
      const key = commitKey(candidate);
      if (emitted.has(key)) continue;
      emitted.add(key);
      localCommits.push(enrichFromSources(candidate, recentIndex, recentRepos, incomingRepos, detail));
    }

    if (localCommits.length > 0) {
      const detailBranch = detail && detail.repo === repoName ? detail.branch : undefined;
      const explicitBranch = recentRepo?.branch !== undefined
        ? recentRepo.branch
        : detailBranch !== undefined
          ? detailBranch
          : localCommits.find((c) => c.branch !== undefined)?.branch;
      const isDetached = explicitBranch === null;
      const rawBase = isDetached
        ? null
        : (recentRepo?.base ?? localCommits.find((c) => c.base !== undefined)?.base ?? null);
      const base = rawBase && rawBase !== explicitBranch ? rawBase : null;
      const branchLabel = isDetached
        ? 'Detached HEAD'
        : typeof explicitBranch === 'string' && explicitBranch.length > 0
          ? (base ? `${explicitBranch} → ${base}` : explicitBranch)
          : 'Current branch';

      const prsByNumber = new Map<number, NewsPullRequest>();
      const prList: NewsPullRequest[] = [];
      for (const pr of recentRepo?.pullRequests ?? []) {
        if (!prsByNumber.has(pr.number)) {
          prsByNumber.set(pr.number, pr);
          prList.push(pr);
        }
      }
      for (const c of localCommits) {
        if (c.pr && !prsByNumber.has(c.pr.number)) {
          prsByNumber.set(c.pr.number, c.pr);
          prList.push(c.pr);
        }
      }

      const prBuckets = new Map<number, SequenceCommit[]>();
      const onBaseCommits: SequenceCommit[] = [];
      const unassignedCommits: SequenceCommit[] = [];
      const olderCommits: SequenceCommit[] = [];

      for (const c of localCommits) {
        const inRecent = recentIndex.has(commitKey(c)) || c.prNumber !== undefined || Boolean(c.onBase);
        if (c.prNumber !== undefined && prsByNumber.has(c.prNumber)) {
          const bucket = prBuckets.get(c.prNumber);
          if (bucket) bucket.push(c);
          else prBuckets.set(c.prNumber, [c]);
        } else if (c.onBase) {
          onBaseCommits.push(c);
        } else if (!inRecent) {
          olderCommits.push(c);
        } else {
          unassignedCommits.push(c);
        }
      }

      const prSections: CommitSectionGroup[] = [];
      for (const pr of prList) {
        const items = prBuckets.get(pr.number);
        if (!items || items.length === 0) continue;
        prSections.push({
          id: `section:${repoName}:pr:${pr.number}`,
          kind: 'pr',
          label: pr.title,
          pr,
          commits: [...items].sort(byNewestCommit),
        });
      }

      const sections: CommitSectionGroup[] = [];
      if (unassignedCommits.length > 0) {
        const hasVisiblePrs = prSections.length > 0;
        sections.push({
          id: hasVisiblePrs ? `section:${repoName}:unassigned-pr` : `section:${repoName}:direct`,
          kind: hasVisiblePrs ? 'unassigned-pr' : 'direct',
          label: hasVisiblePrs ? 'Not in a pull request yet' : '',
          commits: [...unassignedCommits].sort(byNewestCommit),
        });
      }
      sections.push(...prSections);
      if (onBaseCommits.length > 0) {
        sections.push({
          id: `section:${repoName}:on-base`,
          kind: 'on-base',
          label: base ? `Already on ${base}` : 'Already on base',
          commits: [...onBaseCommits].sort(byNewestCommit),
        });
      }
      // With the branch's results loaded, a commit they do not list has no evidence for this branch: it goes to a neutral group below.
      const otherCommits = recent !== undefined ? olderCommits : [];
      if (recent === undefined && olderCommits.length > 0) {
        const useOlderHeading = prSections.length > 0 || onBaseCommits.length > 0 || unassignedCommits.length > 0;
        sections.push({
          id: useOlderHeading ? `section:${repoName}:older` : `section:${repoName}:direct`,
          kind: useOlderHeading ? 'older' : 'direct',
          label: useOlderHeading ? 'Older commits' : '',
          commits: [...olderCommits].sort(byNewestCommit),
        });
      }

      if (sections.length > 0) {
        branches.push({
          id: `branch:${repoName}:local:${isDetached ? 'detached' : explicitBranch || 'current'}`,
          repo: repoName,
          kind: isDetached ? 'detached' : 'local',
          branch: explicitBranch ?? null,
          base,
          label: branchLabel,
          ...(recentRepo?.prsPending ? { prsPending: true } : {}),
          ...(recentRepo?.prsStale ? { prsStale: true } : {}),
          sections,
        });
      }
      if (otherCommits.length > 0) {
        branches.push({
          id: `branch:${repoName}:other`,
          repo: repoName,
          kind: 'other',
          branch: null,
          base: null,
          label: 'Other commits',
          sections: [{
            id: `section:${repoName}:other`,
            kind: 'direct',
            label: '',
            commits: [...otherCommits].sort(byNewestCommit),
          }],
        });
      }
    }

    if (branches.length > 0) {
      const remoteRepo = recentRepo?.remoteRepo ?? incRepo?.remoteRepo ?? null;
      repoGroups.push({
        id: `repo:${repoName}`,
        repo: repoName,
        remoteRepoLabel: remoteRepoDisplayName(repoName, remoteRepo),
        remoteRepo,
        branches,
      });
    }
  }

  return repoGroups;
}

/** Returns every commit across the hierarchical list in exact rendered order (for `[` / `]` stepping). */
export function flattenRepoGroupCommits(groups: readonly CommitRepoGroup[]): SequenceCommit[] {
  return groups.flatMap((repoGroup) =>
    repoGroup.branches.flatMap((branchGroup) =>
      branchGroup.sections.flatMap((section) => section.commits),
    ),
  );
}

/** Returns the collapsible group IDs containing `target` so stepping into a collapsed group can reveal it. */
export function ancestorGroupIdsForCommit(
  groups: readonly CommitRepoGroup[],
  target: CommitRef | null | undefined,
): string[] {
  if (!target) return [];
  for (const repoGroup of groups) {
    for (const branchGroup of repoGroup.branches) {
      for (const section of branchGroup.sections) {
        if (section.commits.some((commit) => sameCommit(commit, target))) {
          return section.kind === 'direct'
            ? [repoGroup.id, branchGroup.id]
            : [repoGroup.id, branchGroup.id, section.id];
        }
      }
    }
  }
  return [];
}

/**
 * Builds deduplicated flat commit groups (`CommitListGroup[]`) for backwards-compatible callers;
 * Review's sidebar uses {@link buildCommitRepoGroups} directly for Repository → Branch → Pull request hierarchy.
 */
export function buildCommitListGroups(
  held: CommitSequence | null,
  recent: RecentCommits | undefined,
  current: CommitRef | null,
  detail?: CommitDetail | null,
  incomingReport?: IncomingCommitsReport,
): CommitListGroup[] {
  const recentRepos = new Map((recent?.commits ?? []).map((r) => [r.repo, r]));
  const incomingRepos = new Map((incomingReport?.repos ?? []).map((r) => [r.repo, r]));
  const recentIndex = new Map<string, SequenceCommit>();
  for (const repoEntry of recent?.commits ?? []) {
    for (const c of repoEntry.commits) {
      const ref: SequenceCommit = {
        repo: repoEntry.repo,
        sha: c.sha,
        subject: c.subject,
        author: c.author,
        at: c.at,
        ...(c.firstBodyLine !== undefined ? { firstBodyLine: c.firstBodyLine } : {}),
        ...(c.fileCount !== undefined ? { fileCount: c.fileCount } : {}),
        ...(c.pushed !== undefined ? { pushed: c.pushed } : {}),
      };
      const k = commitKey(ref);
      if (!recentIndex.has(k)) recentIndex.set(k, ref);
    }
  }

  const enrich = (c: SequenceCommit): SequenceCommit => enrichFromSources(c, recentIndex, recentRepos, incomingRepos, detail);
  const workspaceRepos = new Set<string>();
  for (const r of incomingReport?.repos ?? []) workspaceRepos.add(r.repo);
  for (const r of recent?.commits ?? []) workspaceRepos.add(r.repo);
  for (const c of held?.commits ?? []) workspaceRepos.add(c.repo);
  if (current) workspaceRepos.add(current.repo);
  if (detail) workspaceRepos.add(detail.repo);
  const multiRepo = workspaceRepos.size > 1;

  const emitted = new Set<string>();
  const incomingGroups: CommitListGroup[] = [];
  for (const repoEntry of incomingReport?.repos ?? []) {
    if (repoEntry.commits.length === 0) continue;
    const baseLabel = repoEntry.host?.name
      ? `On ${repoEntry.host.name}, not in your copy yet`
      : 'Not in your copy yet';
    const label = multiRepo ? `${repoEntry.repo} · ${baseLabel}` : baseLabel;
    const items: SequenceCommit[] = [];
    for (const incomingCommit of repoEntry.commits) {
      const candidate: SequenceCommit = {
        repo: repoEntry.repo,
        sha: incomingCommit.sha,
        subject: incomingCommit.subject,
        author: incomingCommit.author,
        at: incomingCommit.at,
        ...(incomingCommit.firstBodyLine !== undefined ? { firstBodyLine: incomingCommit.firstBodyLine } : {}),
        ...(incomingCommit.fileCount !== undefined ? { fileCount: incomingCommit.fileCount } : {}),
        incoming: true,
        host: repoEntry.host,
        webUrl: incomingCommit.webUrl ?? null,
      };
      const key = commitKey(candidate);
      if (recentIndex.has(key) || emitted.has(key)) continue;
      emitted.add(key);
      items.push(enrich(candidate));
    }
    if (items.length > 0) {
      items.sort(byNewestCommit);
      incomingGroups.push({
        id: `incoming:${repoEntry.repo}`,
        label,
        commits: items,
      });
    }
  }

  const baseGroups = composeCommitList(held, recent)
    .map((group, idx) => {
      const sorted = idx === 0 && held ? [...group.commits].sort(byNewestCommit) : group.commits;
      const commits = sorted
        .filter((entry) => {
          const key = commitKey(entry);
          if (emitted.has(key)) return false;
          emitted.add(key);
          return true;
        })
        .map(enrich);
      return { label: group.label, commits };
    })
    .filter((group) => group.commits.length > 0);

  const groups = [...incomingGroups, ...baseGroups];

  if (current) {
    const allPresent = groups.some((g) => g.commits.some((c) => sameCommit(c, current)));
    if (!allPresent) {
      const entry = enrich({ repo: current.repo, sha: current.sha });
      if (baseGroups.length > 0) {
        baseGroups[0] = { ...baseGroups[0]!, commits: [entry, ...baseGroups[0]!.commits] };
        return [...incomingGroups, ...baseGroups];
      }
      groups.push({ label: current.repo, commits: [entry] });
    }
  }

  return groups;
}

function isGroupCollapsed(
  collapsed: ReadonlySet<string> | Readonly<Record<string, boolean>> | undefined,
  id: string | undefined,
): boolean {
  if (!collapsed || !id) return false;
  return collapsed instanceof Set ? collapsed.has(id) : Boolean((collapsed as Readonly<Record<string, boolean>>)[id]);
}

function isRepoGroupList(
  groups: readonly CommitRepoGroup[] | readonly CommitListGroup[],
): groups is readonly CommitRepoGroup[] {
  return groups.length > 0 && 'branches' in groups[0]!;
}

/** Flattens the visible tree items (commits plus only the expanded commit's files, skipping collapsed groups). */
export function flattenCommitTree(
  groups: readonly CommitRepoGroup[] | readonly CommitListGroup[],
  expanded: CommitRef | null,
  expandedFiles: readonly CommitDetailFile[],
  fileOrder?: readonly string[],
  collapsedGroups?: ReadonlySet<string> | Readonly<Record<string, boolean>>,
): CommitTreeRow[] {
  const rows: CommitTreeRow[] = [];
  const fileByPath = new Map(expandedFiles.map((file) => [file.path, file]));
  const orderedFiles: CommitDetailFile[] = fileOrder && fileOrder.length > 0
    ? fileOrder.map((p) => fileByPath.get(p)).filter((f): f is CommitDetailFile => Boolean(f))
    : [...expandedFiles];

  const pushCommits = (commits: readonly SequenceCommit[]) => {
    for (const commit of commits) {
      const isExpanded = Boolean(expanded && sameCommit(commit, expanded));
      rows.push({ kind: 'commit', id: commitItemId(commit), commit, expanded: isExpanded });
      if (isExpanded) {
        for (const file of orderedFiles) {
          rows.push({ kind: 'file', id: fileItemId(commit, file.path), commit, file });
        }
      }
    }
  };

  if (isRepoGroupList(groups)) {
    for (const repoGroup of groups) {
      if (isGroupCollapsed(collapsedGroups, repoGroup.id)) continue;
      for (const branchGroup of repoGroup.branches) {
        if (isGroupCollapsed(collapsedGroups, branchGroup.id)) continue;
        for (const section of branchGroup.sections) {
          if (section.kind !== 'direct' && isGroupCollapsed(collapsedGroups, section.id)) continue;
          pushCommits(section.commits);
        }
      }
    }
  } else {
    for (const group of groups) {
      if (isGroupCollapsed(collapsedGroups, group.id)) continue;
      pushCommits(group.commits);
    }
  }
  return rows;
}

/** Keyboard state transitions when focus is inside the Commits tree (`↑ ↓ → ← Home End Enter Space`). */
export function applyCommitTreeKey(
  rows: readonly CommitTreeRow[],
  state: CommitTreeState,
  key: string,
): CommitTreeMoveResult {
  if (rows.length === 0) return { ...state, handled: false };
  const currentIdx = rows.findIndex((row) => row.id === state.focusId);
  const idx = currentIdx >= 0 ? currentIdx : 0;
  const active = rows[idx]!;

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const delta = key === 'ArrowDown' ? 1 : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, idx + delta))]!;
    if (next.kind === 'commit') {
      return {
        commit: { repo: next.commit.repo, sha: next.commit.sha },
        expanded: state.expanded,
        file: null,
        focusId: next.id,
        handled: true,
      };
    }
    return {
      commit: { repo: next.commit.repo, sha: next.commit.sha },
      expanded: { repo: next.commit.repo, sha: next.commit.sha },
      file: next.file.path,
      focusId: next.id,
      handled: true,
    };
  }

  if (key === 'ArrowRight') {
    if (active.kind === 'commit') {
      if (!active.expanded) {
        return {
          commit: { repo: active.commit.repo, sha: active.commit.sha },
          expanded: { repo: active.commit.repo, sha: active.commit.sha },
          file: null,
          focusId: active.id,
          handled: true,
        };
      }
      const next = rows[idx + 1];
      if (next && next.kind === 'file' && sameCommit(next.commit, active.commit)) {
        return {
          commit: { repo: active.commit.repo, sha: active.commit.sha },
          expanded: { repo: active.commit.repo, sha: active.commit.sha },
          file: next.file.path,
          focusId: next.id,
          handled: true,
        };
      }
      return { ...state, handled: true };
    }
    return { ...state, handled: true };
  }

  if (key === 'ArrowLeft') {
    if (active.kind === 'file') {
      const parentId = commitItemId(active.commit);
      return {
        commit: { repo: active.commit.repo, sha: active.commit.sha },
        expanded: { repo: active.commit.repo, sha: active.commit.sha },
        file: null,
        focusId: parentId,
        handled: true,
      };
    }
    if (active.expanded) {
      return {
        commit: { repo: active.commit.repo, sha: active.commit.sha },
        expanded: null,
        file: null,
        focusId: active.id,
        handled: true,
      };
    }
    return { ...state, handled: true };
  }

  if (key === 'Home') {
    const first = rows[0]!;
    return {
      commit: { repo: first.commit.repo, sha: first.commit.sha },
      expanded: first.kind === 'file' ? { repo: first.commit.repo, sha: first.commit.sha } : state.expanded,
      file: first.kind === 'file' ? first.file.path : null,
      focusId: first.id,
      handled: true,
    };
  }

  if (key === 'End') {
    const last = rows[rows.length - 1]!;
    return {
      commit: { repo: last.commit.repo, sha: last.commit.sha },
      expanded: last.kind === 'file' ? { repo: last.commit.repo, sha: last.commit.sha } : state.expanded,
      file: last.kind === 'file' ? last.file.path : null,
      focusId: last.id,
      handled: true,
    };
  }

  if (key === 'Enter' || key === ' ') {
    if (active.kind === 'file') {
      return {
        commit: { repo: active.commit.repo, sha: active.commit.sha },
        expanded: { repo: active.commit.repo, sha: active.commit.sha },
        file: active.file.path,
        focusId: active.id,
        handled: true,
        chosen: true,
      };
    }
    const viewingCommitItself = sameCommit(state.commit, active.commit) && state.file === null;
    if (viewingCommitItself && active.expanded) {
      return {
        commit: { repo: active.commit.repo, sha: active.commit.sha },
        expanded: null,
        file: null,
        focusId: active.id,
        handled: true,
        chosen: true,
      };
    }
    return {
      commit: { repo: active.commit.repo, sha: active.commit.sha },
      expanded: { repo: active.commit.repo, sha: active.commit.sha },
      file: null,
      focusId: active.id,
      handled: true,
      chosen: true,
    };
  }

  return { ...state, handled: false };
}
