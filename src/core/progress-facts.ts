/**
 * @module core/progress-facts
 * Checkable facts about where a workspace's work stands, for the progress strip,
 * the Context Ring and the Up next queue. Every number is derived from stored
 * state (the lifecycle, the chat ledger, git, the last verification). Nothing
 * here is generated prose, and a source that cannot be read is reported as
 * unavailable instead of being guessed.
 *
 * This is not {@link ./progress.ts}, which reports branch, push and pull
 * request state.
 */

import { execa } from 'execa';

import type { LifecycleStep, VerificationStatus, WorkspaceVerificationReport } from '../types.js';
import { getWorkspaceRepos } from '../utils/multi-git.js';
import { listOpenInputRequests, type InputRequest } from './attention.js';
import { loadWorkspaceLifecycle } from './lifecycle.js';
import { listRepositoryChanges } from './repository-changes.js';
import { loadWorkspaceState } from './workspace-state.js';

/** Where one milestone stands. Work loops back, so `reopened` is a state of its own. */
export type MilestoneState = 'done' | 'in_progress' | 'reopened' | 'blocked' | 'upcoming';

export interface MilestoneFact {
  id: string;
  title: string;
  state: MilestoneState;
  /** The last verification gate passed for the work as it stands. */
  verified: boolean;
  completedAt?: string;
  /** Present while the milestone is being redone after being finished. */
  reopen?: { at: string; reason: string; by: 'user' | 'agent' };
  /** Times this milestone has been reopened, including finished rework. */
  reopenCount: number;
  /** Milestones it depends on that are not finished. */
  waitingOn: string[];
  unblockCondition?: string;
  /** Why the milestone is blocked, in the words of whoever said so. Present only while it is blocked. */
  blockedReason?: string;
}

export interface MilestoneCounts {
  total: number;
  done: number;
  inProgress: number;
  reopened: number;
  blocked: number;
  upcoming: number;
}

export interface RepoChangeFact {
  repoName: string;
  files: number;
  additions: number;
  deletions: number;
  /** The repository could not be read, so its counts are not known. */
  unavailable?: boolean;
}

export interface ChangeFacts {
  repos: RepoChangeFact[];
  files: number;
  additions: number;
  deletions: number;
}

export interface VerificationFact {
  /** `never` when no verification has run. */
  status: VerificationStatus | 'never';
  verifiedAt?: string;
  durationMs?: number;
  /** Whether the code still matches what was verified. `unknown` when that cannot be checked. */
  freshness: 'fresh' | 'stale' | 'unknown';
}

export type ProgressSource = 'milestones' | 'questions' | 'changes' | 'verification';

export interface ProgressFacts {
  workspaceId: string;
  generatedAt: string;
  milestones: MilestoneFact[];
  counts: MilestoneCounts;
  currentMilestoneId?: string;
  /** The milestone to start next, by the plan's one rule; it may still wait for something. */
  nextMilestoneId?: string;
  /** Questions the AI asked that nobody has marked answered. These are the AI's own words. */
  openQuestions: InputRequest[];
  changes: ChangeFacts;
  verification: VerificationFact;
  /** Sources that could not be read. Their facts above are empty, not zero. */
  unavailable: Array<{ source: ProgressSource; reason: string }>;
}

/** Turns stored lifecycle steps into milestone facts, in plan order. */
export function deriveMilestoneFacts(steps: readonly LifecycleStep[]): MilestoneFact[] {
  const finished = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
  return steps.map((step): MilestoneFact => {
    const reopened = Boolean(step.reopenedAt) && step.status !== 'completed';
    // Blocked says what stops the work now, so it wins over reopened; the reopen stays on record.
    const state: MilestoneState = step.status === 'completed' ? 'done'
      : step.status === 'blocked' ? 'blocked'
        : reopened ? 'reopened'
          : step.status === 'in_progress' || step.status === 'verified' ? 'in_progress'
            : 'upcoming';
    return {
      id: step.id,
      title: step.title,
      state,
      verified: step.status === 'verified' || (step.status === 'completed' && step.lastVerificationStatus !== undefined
        && step.lastVerificationStatus !== 'fail' && step.lastVerificationStatus !== 'timeout'),
      ...(step.completedAt ? { completedAt: step.completedAt } : {}),
      ...(reopened && step.reopenedAt ? { reopen: { at: step.reopenedAt, reason: step.reopenReason ?? '', by: step.reopenedBy ?? 'user' } } : {}),
      reopenCount: step.reopenCount ?? 0,
      waitingOn: state === 'done' ? [] : (step.dependsOn ?? []).filter((id) => !finished.has(id)),
      ...(step.unblockCondition ? { unblockCondition: step.unblockCondition } : {}),
      ...(state === 'blocked' && step.blockedReason ? { blockedReason: step.blockedReason } : {}),
    };
  });
}

export function countMilestones(milestones: readonly MilestoneFact[]): MilestoneCounts {
  const count = (state: MilestoneState) => milestones.filter((milestone) => milestone.state === state).length;
  return {
    total: milestones.length,
    done: count('done'),
    inProgress: count('in_progress'),
    reopened: count('reopened'),
    blocked: count('blocked'),
    upcoming: count('upcoming'),
  };
}

export function summariseChanges(repos: readonly RepoChangeFact[]): ChangeFacts {
  return {
    repos: [...repos],
    files: repos.reduce((sum, repo) => sum + repo.files, 0),
    additions: repos.reduce((sum, repo) => sum + repo.additions, 0),
    deletions: repos.reduce((sum, repo) => sum + repo.deletions, 0),
  };
}

export interface LiveRepoState {
  repoName: string;
  headSha: string | null;
  dirty: boolean;
}

/**
 * The last workspace verification, and whether the code still matches it. A
 * proof is stale once HEAD moved, or once a repository that was clean when
 * verified has changes again. Without live state for a verified repository the
 * answer is `unknown`, never `fresh`.
 */
export function describeVerification(
  report: WorkspaceVerificationReport | undefined,
  live: readonly LiveRepoState[],
): VerificationFact {
  if (!report) return { status: 'never', freshness: 'unknown' };
  let freshness: VerificationFact['freshness'] = report.repos.length === 0 ? 'unknown' : 'fresh';
  for (const proof of report.repos) {
    const now = live.find((repo) => repo.repoName === proof.repoName);
    if (!now || !now.headSha) {
      if (freshness === 'fresh') freshness = 'unknown';
      continue;
    }
    if (now.headSha !== proof.headSha || (proof.clean && now.dirty)) return {
      status: report.overallStatus, verifiedAt: report.verifiedAt, durationMs: report.durationMs, freshness: 'stale',
    };
  }
  return { status: report.overallStatus, verifiedAt: report.verifiedAt, durationMs: report.durationMs, freshness };
}

const REASON_LIMIT = 200;

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, REASON_LIMIT) || 'Unknown error';
}

async function headOf(repoPath: string): Promise<string | null> {
  return execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).then((result) => result.stdout.trim()).catch(() => null);
}

/**
 * Gathers the facts for one workspace. A source that fails is listed under
 * `unavailable` and contributes empty facts; the others still report. It reads
 * the lifecycle without the remote branch fleet, so it is cheap enough to poll.
 */
export async function getProgressFacts(workspacePath: string, now: Date = new Date()): Promise<ProgressFacts> {
  const unavailable: ProgressFacts['unavailable'] = [];
  const settle = async <T>(source: ProgressSource, fallback: T, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      unavailable.push({ source, reason: shortReason(error) });
      return fallback;
    }
  };

  const lifecycle = await settle('milestones', undefined, () => loadWorkspaceLifecycle(workspacePath, { includeFleet: false }));
  const milestones = deriveMilestoneFacts(lifecycle?.steps ?? []);
  const current = lifecycle?.steps.find((step) => step.id === lifecycle.currentStepId);
  const currentMilestoneId = current && current.status !== 'completed'
    ? current.id
    : milestones.find((milestone) => milestone.state === 'reopened' || milestone.state === 'in_progress')?.id;

  const [openQuestions, live, verification] = await Promise.all([
    settle('questions', [] as InputRequest[], () => listOpenInputRequests(workspacePath, now.getTime())),
    settle('changes', undefined, async () => {
      const repos = await getWorkspaceRepos(workspacePath);
      return Promise.all(repos.map(async (repo) => {
        try {
          const files = await listRepositoryChanges(repo.path);
          return {
            fact: {
              repoName: repo.name,
              files: files.length,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            } satisfies RepoChangeFact,
            state: { repoName: repo.name, headSha: await headOf(repo.path), dirty: files.length > 0 } satisfies LiveRepoState,
          };
        } catch {
          return {
            fact: { repoName: repo.name, files: 0, additions: 0, deletions: 0, unavailable: true } satisfies RepoChangeFact,
            state: { repoName: repo.name, headSha: null, dirty: false } satisfies LiveRepoState,
          };
        }
      }));
    }),
    settle('verification', undefined, async () => (await loadWorkspaceState(workspacePath)).lastVerification),
  ]);

  const changeFacts = summariseChanges((live ?? []).map((entry) => entry.fact));
  const liveStates = (live ?? []).map((entry) => entry.state);
  // `verification` is undefined both for "never verified" and for "could not read"; the latter is listed under `unavailable`.
  return {
    workspaceId: lifecycle?.workspaceId ?? '',
    generatedAt: now.toISOString(),
    milestones,
    counts: countMilestones(milestones),
    ...(currentMilestoneId ? { currentMilestoneId } : {}),
    ...(lifecycle?.nextStepId ? { nextMilestoneId: lifecycle.nextStepId } : {}),
    openQuestions,
    changes: changeFacts,
    verification: describeVerification(verification, liveStates),
    unavailable,
  };
}
