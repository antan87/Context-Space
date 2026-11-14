import type { CommitDetail, CommitDetailFile, CommitStepLink } from '../board/commitContext.js';
import type { RecentCommits } from '../plan/whatsNew.js';
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

/**
 * Builds the deduplicated left-hand commit groups:
 * 1) held row commits (newest first, enriched from recent & detail)
 * 2) other recent commits
 * 3) if the open commit isn't in either source, ensures it is still shown once
 */
export function buildCommitListGroups(
  held: CommitSequence | null,
  recent: RecentCommits | undefined,
  current: CommitRef | null,
  detail?: CommitDetail | null,
): CommitListGroup[] {
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

  const enrich = (c: SequenceCommit): SequenceCommit => {
    const r = recentIndex.get(commitKey(c));
    const fromDetail = detail && sameCommit(detail, c) ? detail : null;
    const detailFileCount = fromDetail ? fromDetail.files.length + fromDetail.moreFiles : undefined;
    const detailFirstLine = fromDetail ? firstDescriptionLine(fromDetail.body) : undefined;
    return {
      repo: c.repo,
      sha: c.sha,
      subject: c.subject ?? r?.subject ?? fromDetail?.subject,
      author: c.author ?? r?.author ?? fromDetail?.author,
      at: c.at ?? r?.at ?? fromDetail?.at,
      firstBodyLine: c.firstBodyLine ?? r?.firstBodyLine ?? detailFirstLine,
      fileCount: c.fileCount ?? r?.fileCount ?? detailFileCount,
      pushed: c.pushed ?? r?.pushed ?? fromDetail?.pushed,
    };
  };

  const baseGroups = composeCommitList(held, recent).map((group, idx) => {
    const sorted = idx === 0 && held ? [...group.commits].sort(byNewestCommit) : group.commits;
    return { label: group.label, commits: sorted.map(enrich) };
  });

  if (current) {
    const allPresent = baseGroups.some((g) => g.commits.some((c) => sameCommit(c, current)));
    if (!allPresent) {
      const entry = enrich({ repo: current.repo, sha: current.sha });
      if (baseGroups.length > 0) {
        baseGroups[0] = { ...baseGroups[0]!, commits: [entry, ...baseGroups[0]!.commits] };
      } else {
        baseGroups.push({ label: current.repo, commits: [entry] });
      }
    }
  }

  return baseGroups;
}

/** Flattens the visible tree items (commits plus only the expanded commit's files). */
export function flattenCommitTree(
  groups: readonly CommitListGroup[],
  expanded: CommitRef | null,
  expandedFiles: readonly CommitDetailFile[],
  fileOrder?: readonly string[],
): CommitTreeRow[] {
  const rows: CommitTreeRow[] = [];
  const fileByPath = new Map(expandedFiles.map((file) => [file.path, file]));
  const orderedFiles: CommitDetailFile[] = fileOrder && fileOrder.length > 0
    ? fileOrder.map((p) => fileByPath.get(p)).filter((f): f is CommitDetailFile => Boolean(f))
    : [...expandedFiles];

  for (const group of groups) {
    for (const commit of group.commits) {
      const isExpanded = Boolean(expanded && sameCommit(commit, expanded));
      rows.push({ kind: 'commit', id: commitItemId(commit), commit, expanded: isExpanded });
      if (isExpanded) {
        for (const file of orderedFiles) {
          rows.push({ kind: 'file', id: fileItemId(commit, file.path), commit, file });
        }
      }
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
