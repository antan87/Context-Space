import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleStep, WorkspaceVerificationReport } from '../types.js';
import {
  countMilestones,
  deriveMilestoneFacts,
  describeVerification,
  getProgressFacts,
  summariseChanges,
} from './progress-facts.js';

vi.mock('./lifecycle.js', () => ({ loadWorkspaceLifecycle: vi.fn() }));
vi.mock('./attention.js', () => ({ listOpenInputRequests: vi.fn() }));
vi.mock('./repository-changes.js', () => ({ listRepositoryChanges: vi.fn() }));
vi.mock('./workspace-state.js', () => ({ loadWorkspaceState: vi.fn() }));
vi.mock('../utils/multi-git.js', () => ({ getWorkspaceRepoPaths: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { listOpenInputRequests } from './attention.js';
import { loadWorkspaceLifecycle } from './lifecycle.js';
import { listRepositoryChanges } from './repository-changes.js';
import { loadWorkspaceState } from './workspace-state.js';

const step = (id: string, over: Partial<LifecycleStep> = {}): LifecycleStep => ({ id, title: id.toUpperCase(), status: 'pending', ...over });

describe('deriveMilestoneFacts', () => {
  it('maps every stored status to a milestone state, in plan order', () => {
    const facts = deriveMilestoneFacts([
      step('a', { status: 'completed' }),
      step('b', { status: 'in_progress' }),
      step('c', { status: 'verified' }),
      step('d', { status: 'blocked' }),
      step('e', { status: 'pending' }),
    ]);
    expect(facts.map((f) => [f.id, f.state])).toEqual([['a', 'done'], ['b', 'in_progress'], ['c', 'in_progress'], ['d', 'blocked'], ['e', 'upcoming']]);
  });

  it('shows a reopened milestone as reopened, with when, why and by whom', () => {
    const [fact] = deriveMilestoneFacts([step('plan', {
      status: 'in_progress', reopenedAt: '2026-10-02T10:00:00.000Z', reopenReason: 'Gap in step 2', reopenedBy: 'user', reopenCount: 1,
    })]);
    expect(fact).toMatchObject({
      state: 'reopened', reopenCount: 1,
      reopen: { at: '2026-10-02T10:00:00.000Z', reason: 'Gap in step 2', by: 'user' },
    });
  });

  it('keeps a reopened milestone reopened even after its gate passes, until it is completed again', () => {
    const [fact] = deriveMilestoneFacts([step('plan', { status: 'verified', reopenedAt: '2026-10-02T10:00:00.000Z', reopenReason: 'x', reopenedBy: 'agent', lastVerificationStatus: 'pass' })]);
    expect(fact).toMatchObject({ state: 'reopened', verified: true });
  });

  it('shows a reopened milestone that is then blocked as blocked, with its reason, and keeps the reopen on record', () => {
    const facts = deriveMilestoneFacts([step('api', { status: 'blocked', blockedReason: 'Waiting on keys', reopenedAt: '2026-10-02T10:00:00.000Z', reopenReason: 'Gap', reopenedBy: 'user' })]);
    expect(facts[0]).toMatchObject({ state: 'blocked', blockedReason: 'Waiting on keys', reopen: { reason: 'Gap', by: 'user' } });
    expect(countMilestones(facts)).toMatchObject({ blocked: 1, reopened: 0 });
  });

  it('shows a milestone done once it is completed again, and remembers it was reopened', () => {
    const [fact] = deriveMilestoneFacts([step('plan', { status: 'completed', completedAt: '2026-10-03T10:00:00.000Z', reopenCount: 2, lastVerificationStatus: 'pass' })]);
    expect(fact).toMatchObject({ state: 'done', reopenCount: 2, completedAt: '2026-10-03T10:00:00.000Z' });
    expect(fact).not.toHaveProperty('reopen');
  });

  it('only calls a milestone verified when the gate did not fail or time out', () => {
    const verified = (status: LifecycleStep['lastVerificationStatus']) =>
      deriveMilestoneFacts([step('a', { status: 'completed', lastVerificationStatus: status })])[0]!.verified;
    expect(verified('pass')).toBe(true);
    expect(verified('pass_dirty')).toBe(true);
    expect(verified('fail')).toBe(false);
    expect(verified('timeout')).toBe(false);
    expect(verified(undefined)).toBe(false);
    expect(deriveMilestoneFacts([step('a', { status: 'in_progress', lastVerificationStatus: 'pass' })])[0]!.verified).toBe(false);
  });

  it('lists only the dependencies that are not finished, and none for finished work', () => {
    const facts = deriveMilestoneFacts([
      step('a', { status: 'completed' }),
      step('b', { status: 'in_progress' }),
      step('c', { status: 'pending', dependsOn: ['a', 'b', 'ghost'], unblockCondition: 'Owner decides' }),
      step('d', { status: 'completed', dependsOn: ['b'] }),
    ]);
    expect(facts[2]).toMatchObject({ waitingOn: ['b', 'ghost'], unblockCondition: 'Owner decides' });
    expect(facts[3]!.waitingOn).toEqual([]);
  });

  it('waits on a dependency that was reopened', () => {
    const facts = deriveMilestoneFacts([
      step('plan', { status: 'in_progress', reopenedAt: '2026-10-02T10:00:00.000Z' }),
      step('build', { status: 'pending', dependsOn: ['plan'] }),
    ]);
    expect(facts[1]!.waitingOn).toEqual(['plan']);
  });

  it('treats an unknown stored status as upcoming instead of failing', () => {
    expect(deriveMilestoneFacts([step('a', { status: 'archived' as any })])[0]!.state).toBe('upcoming');
  });

  it('returns nothing for an empty plan', () => {
    expect(deriveMilestoneFacts([])).toEqual([]);
  });
});

describe('countMilestones', () => {
  it('counts each state and the total', () => {
    const facts = deriveMilestoneFacts([
      step('a', { status: 'completed' }), step('b', { status: 'completed' }),
      step('c', { status: 'in_progress', reopenedAt: 'x' }), step('d', { status: 'in_progress' }),
      step('e', { status: 'blocked' }), step('f'),
    ]);
    expect(countMilestones(facts)).toEqual({ total: 6, done: 2, inProgress: 1, reopened: 1, blocked: 1, upcoming: 1 });
  });

  it('is all zeros for an empty plan', () => {
    expect(countMilestones([])).toEqual({ total: 0, done: 0, inProgress: 0, reopened: 0, blocked: 0, upcoming: 0 });
  });
});

describe('summariseChanges', () => {
  it('adds up files and lines across repositories', () => {
    expect(summariseChanges([
      { repoName: 'a', files: 2, additions: 10, deletions: 3 },
      { repoName: 'b', files: 1, additions: 5, deletions: 0 },
    ])).toMatchObject({ files: 3, additions: 15, deletions: 3 });
  });

  it('is zero without repositories', () => {
    expect(summariseChanges([])).toEqual({ repos: [], files: 0, additions: 0, deletions: 0 });
  });
});

const proof = (over: Record<string, unknown> = {}) => ({
  repoName: 'app', repoPath: '/x', status: 'pass', command: 'npm test', exitCode: 0, headSha: 'aaa', clean: true, durationMs: 10, verifiedAt: 't', ...over,
});
const report = (repos: any[], over: Partial<WorkspaceVerificationReport> = {}): WorkspaceVerificationReport => ({
  workspacePath: '/w', overallStatus: 'pass', canProgress: true, verifiedAt: '2026-10-02T10:00:00.000Z', durationMs: 1234, repos, ...over,
});

describe('describeVerification', () => {
  it('says never when nothing has been verified', () => {
    expect(describeVerification(undefined, [])).toEqual({ status: 'never', freshness: 'unknown' });
  });

  it('is fresh when HEAD is unchanged and a clean proof is still clean', () => {
    expect(describeVerification(report([proof()]), [{ repoName: 'app', headSha: 'aaa', dirty: false }])).toEqual({
      status: 'pass', verifiedAt: '2026-10-02T10:00:00.000Z', durationMs: 1234, freshness: 'fresh',
    });
  });

  it('is stale once HEAD moved', () => {
    expect(describeVerification(report([proof()]), [{ repoName: 'app', headSha: 'bbb', dirty: false }]).freshness).toBe('stale');
  });

  it('is stale when a repository that was clean when verified has changes again', () => {
    expect(describeVerification(report([proof()]), [{ repoName: 'app', headSha: 'aaa', dirty: true }]).freshness).toBe('stale');
  });

  it('stays fresh when the proof was taken on a dirty tree and it is still dirty at the same HEAD', () => {
    expect(describeVerification(report([proof({ clean: false })], { overallStatus: 'pass_dirty' }), [{ repoName: 'app', headSha: 'aaa', dirty: true }])).toMatchObject({ status: 'pass_dirty', freshness: 'fresh' });
  });

  it('is unknown, never fresh, when live state for a verified repository is missing or unreadable', () => {
    expect(describeVerification(report([proof()]), []).freshness).toBe('unknown');
    expect(describeVerification(report([proof()]), [{ repoName: 'app', headSha: null, dirty: false }]).freshness).toBe('unknown');
  });

  it('is unknown for a report that covers no repositories', () => {
    expect(describeVerification(report([]), []).freshness).toBe('unknown');
  });

  it('reports stale even when another repository could not be read', () => {
    const result = describeVerification(report([proof(), proof({ repoName: 'lib', headSha: 'ccc' })]), [{ repoName: 'app', headSha: 'zzz', dirty: false }]);
    expect(result.freshness).toBe('stale');
  });

  it('carries the failing status through so a red gate is not shown as green', () => {
    expect(describeVerification(report([proof({ status: 'fail' })], { overallStatus: 'fail', canProgress: false }), [{ repoName: 'app', headSha: 'aaa', dirty: false }]).status).toBe('fail');
  });
});

describe('getProgressFacts', () => {
  const NOW = new Date('2026-10-02T12:00:00.000Z');
  const lifecycle = (steps: LifecycleStep[], currentStepId?: string) => ({ workspaceId: 'ws', flowType: 'feature' as const, steps, currentStepId, updatedAt: 't' });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(loadWorkspaceLifecycle).mockResolvedValue(lifecycle([
      step('plan', { status: 'completed' }), step('build', { status: 'in_progress' }), step('ship'),
    ], 'build'));
    vi.mocked(listOpenInputRequests).mockResolvedValue([{ id: 'q1', timestamp: '2026-10-02T11:00:00.000Z', harness: 'claude', message: 'Which branch?' }]);
    vi.mocked(getWorkspaceRepoPaths).mockResolvedValue([{ name: 'app', path: '/repos/app' }, { name: 'lib', path: '/repos/lib' }] as any);
    vi.mocked(listRepositoryChanges).mockImplementation(async (repoPath: string) => repoPath === '/repos/app'
      ? [{ file: 'a.ts', type: 'modified', rawStatus: 'M', additions: 10, deletions: 2 }, { file: 'b.ts', type: 'added', rawStatus: '??', additions: 4, deletions: 0 }]
      : []);
    vi.mocked(execa).mockImplementation((async (_cmd: string, _args: string[], options: { cwd: string }) => ({ stdout: options.cwd === '/repos/app' ? 'aaa' : 'lll\n' })) as any);
    vi.mocked(loadWorkspaceState).mockResolvedValue({ workspacePath: '/w', repos: {}, updatedAt: '', lastVerification: report([proof({ clean: false }), proof({ repoName: 'lib', headSha: 'lll' })]) } as any);
  });

  it('gathers milestones, questions, changes and verification into one set of facts', async () => {
    const facts = await getProgressFacts('/w', NOW);
    expect(facts).toMatchObject({
      workspaceId: 'ws',
      generatedAt: '2026-10-02T12:00:00.000Z',
      currentMilestoneId: 'build',
      counts: { total: 3, done: 1, inProgress: 1, upcoming: 1 },
      openQuestions: [{ id: 'q1', message: 'Which branch?' }],
      changes: { files: 2, additions: 14, deletions: 2 },
      verification: { status: 'pass', freshness: 'fresh' },
      unavailable: [],
    });
    expect(facts.changes.repos).toEqual([
      { repoName: 'app', files: 2, additions: 14, deletions: 2 },
      { repoName: 'lib', files: 0, additions: 0, deletions: 0 },
    ]);
  });

  it('reads the lifecycle without the remote branch fleet, so it is cheap to poll', async () => {
    await getProgressFacts('/w', NOW);
    expect(loadWorkspaceLifecycle).toHaveBeenCalledWith('/w', { includeFleet: false });
  });

  it('falls back to the first active milestone when the saved current one is already finished', async () => {
    vi.mocked(loadWorkspaceLifecycle).mockResolvedValue(lifecycle([step('plan', { status: 'completed' }), step('build', { status: 'in_progress' })], 'plan'));
    expect((await getProgressFacts('/w', NOW)).currentMilestoneId).toBe('build');
  });

  it('names a reopened milestone as current when the saved current one is gone', async () => {
    vi.mocked(loadWorkspaceLifecycle).mockResolvedValue(lifecycle([
      step('plan', { status: 'in_progress', reopenedAt: 'x', reopenReason: 'gap' }), step('build'),
    ], 'removed'));
    expect((await getProgressFacts('/w', NOW)).currentMilestoneId).toBe('plan');
  });

  it('has no current milestone when everything is finished or nothing is planned', async () => {
    vi.mocked(loadWorkspaceLifecycle).mockResolvedValue(lifecycle([step('plan', { status: 'completed' })], 'plan'));
    expect((await getProgressFacts('/w', NOW)).currentMilestoneId).toBeUndefined();
    vi.mocked(loadWorkspaceLifecycle).mockResolvedValue(lifecycle([]));
    const empty = await getProgressFacts('/w', NOW);
    expect(empty.currentMilestoneId).toBeUndefined();
    expect(empty.counts.total).toBe(0);
  });

  it('keeps reporting the other facts when the lifecycle cannot be read, and says so', async () => {
    vi.mocked(loadWorkspaceLifecycle).mockRejectedValue(new Error('state file is corrupt'));
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.milestones).toEqual([]);
    expect(facts.workspaceId).toBe('');
    expect(facts.changes.files).toBe(2);
    expect(facts.unavailable).toEqual([{ source: 'milestones', reason: 'state file is corrupt' }]);
  });

  it('keeps reporting the other facts when the ledger cannot be read', async () => {
    vi.mocked(listOpenInputRequests).mockRejectedValue(new Error('EACCES: permission denied'));
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.openQuestions).toEqual([]);
    expect(facts.counts.total).toBe(3);
    expect(facts.unavailable).toEqual([{ source: 'questions', reason: 'EACCES: permission denied' }]);
  });

  it('marks one unreadable repository instead of failing the rest, and does not call its verification fresh', async () => {
    vi.mocked(listRepositoryChanges).mockImplementation(async (repoPath: string) => {
      if (repoPath === '/repos/lib') throw new Error('not a git repository');
      return [{ file: 'a.ts', type: 'modified', rawStatus: 'M', additions: 1, deletions: 1 }];
    });
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.changes.repos).toEqual([
      { repoName: 'app', files: 1, additions: 1, deletions: 1 },
      { repoName: 'lib', files: 0, additions: 0, deletions: 0, unavailable: true },
    ]);
    // app was verified on the same dirty tree, so it still matches; lib could not be read, so the whole answer is unknown.
    expect(facts.verification.freshness).toBe('unknown');
    expect(facts.unavailable).toEqual([]);
  });

  it('reports changes as unavailable when the workspace repositories cannot be listed', async () => {
    vi.mocked(getWorkspaceRepoPaths).mockRejectedValue(new Error('manifest missing'));
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.changes).toEqual({ repos: [], files: 0, additions: 0, deletions: 0 });
    expect(facts.unavailable).toEqual([{ source: 'changes', reason: 'manifest missing' }]);
    expect(facts.verification.freshness).toBe('unknown');
  });

  it('reports verification as unavailable when the saved state cannot be read, and not as never verified', async () => {
    vi.mocked(loadWorkspaceState).mockRejectedValue(new Error('bad json'));
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.unavailable).toEqual([{ source: 'verification', reason: 'bad json' }]);
  });

  it('says never verified when the state is readable and holds no verification', async () => {
    vi.mocked(loadWorkspaceState).mockResolvedValue({ workspacePath: '/w', repos: {}, updatedAt: '' } as any);
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.verification).toEqual({ status: 'never', freshness: 'unknown' });
    expect(facts.unavailable).toEqual([]);
  });

  it('cleans control characters out of an error reason and keeps it short', async () => {
    vi.mocked(listOpenInputRequests).mockRejectedValue(new Error('bad\u001b[31m thing\n' + 'x'.repeat(500)));
    const [problem] = (await getProgressFacts('/w', NOW)).unavailable;
    expect(problem!.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(problem!.reason.length).toBeLessThanOrEqual(200);
  });

  it('does not count a repository whose HEAD cannot be read as fresh', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('no HEAD') as never);
    const facts = await getProgressFacts('/w', NOW);
    expect(facts.verification.freshness).toBe('unknown');
  });
});
