import { describe, expect, it } from 'vitest';
import type { CommitDetail, CommitDetailFile } from '../board/commitContext.js';
import type { IncomingCommitsReport, RecentCommits } from '../plan/whatsNew.js';
import {
  ancestorGroupIdsForCommit,
  applyCommitTreeKey,
  buildCommitListGroups,
  buildCommitRepoGroups,
  commitItemId,
  fileItemId,
  firstDescriptionLine,
  flattenCommitTree,
  flattenRepoGroupCommits,
  formatCommitStepLabel,
  remoteRepoDisplayName,
  splitFilePath,
  statusCode,
} from './commitListModel.js';
import type { CommitSequence } from './commitsMode.js';

describe('splitFilePath and statusCode', () => {
  it('separates basename and folder with root files having an empty dir', () => {
    expect(splitFilePath('gui/src/features/changes/CommitsView.tsx')).toEqual({
      name: 'CommitsView.tsx',
      dir: 'gui/src/features/changes',
    });
    expect(splitFilePath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });

  it('maps file statuses to single letters', () => {
    expect(statusCode('modified')).toBe('M');
    expect(statusCode('added')).toBe('A');
    expect(statusCode('deleted')).toBe('D');
    expect(statusCode('renamed')).toBe('R');
    expect(statusCode('copied')).toBe('C');
  });
});

describe('formatCommitStepLabel', () => {
  it('uses short colon prefix plus start of step and checkpoint title', () => {
    const out = formatCommitStepLabel({
      key: 'rv1',
      text: '**RV1**: One `Review` page instead of the floating Code window so navigation is clear and reversible',
      done: true,
      checkpointTitle: 'The Board is powerful enough',
    });
    expect(out.prefix).toBe('RV1');
    expect(out.checkpoint).toBe('The Board is powerful enough');
    expect(out.label).toContain('RV1:');
    expect(out.label).toContain('· The Board is powerful enough');
    expect(out.label.length).toBeLessThan(out.title.length);
    expect(out.title).toBe('RV1: One Review page instead of the floating Code window so navigation is clear and reversible · The Board is powerful enough');
  });

  it('does not treat long prose before a colon or URLs as a short prefix', () => {
    const longPrefix = formatCommitStepLabel({
      key: 's1',
      text: 'This is a very long step explanation: with details later',
      done: false,
    });
    expect(longPrefix.prefix).toBeNull();
    expect(longPrefix.label.startsWith('This is a very long')).toBe(true);

    const urlStep = formatCommitStepLabel({
      key: 's2',
      text: 'https://example.com/docs overview page',
      done: false,
    });
    expect(urlStep.prefix).toBeNull();
  });
});

describe('firstDescriptionLine', () => {
  it('returns the first non-empty line or undefined for empty descriptions', () => {
    expect(firstDescriptionLine(undefined)).toBeUndefined();
    expect(firstDescriptionLine('  \n\r\n')).toBeUndefined();
    expect(firstDescriptionLine('\n\n  First line here \n\nSecond paragraph')).toBe('First line here');
  });
});

describe('buildCommitListGroups and deduplication', () => {
  const held: CommitSequence = {
    label: 'Export',
    commits: [
      { repo: 'api', sha: 'aaaaaaa1111111', subject: 'Older held', author: 'A', at: '2026-11-10T09:00:00Z' },
      { repo: 'api', sha: 'bbbbbbb2222222', subject: 'Newer held', author: 'A', at: '2026-11-10T11:00:00Z' },
    ],
  };
  const recent: RecentCommits = {
    at: '2026-11-10T12:00:00Z',
    from: '2026-11-07T12:00:00Z',
    commits: [{
      repo: 'api',
      more: 0,
      commits: [
        { sha: 'bbbbbbb', subject: 'Newer held', author: 'A', at: '2026-11-10T11:00:00Z', fileCount: 3, pushed: false, firstBodyLine: 'Held body' },
        { sha: 'aaaaaaa', subject: 'Older held', author: 'A', at: '2026-11-10T09:00:00Z', fileCount: 1, pushed: true },
        { sha: 'ccccccc', subject: 'Other recent', author: 'B', at: '2026-11-10T10:00:00Z', fileCount: 5, pushed: true, firstBodyLine: 'Other summary' },
      ],
    }],
  };

  it('orders held commits newest first, enriches metadata, and puts remaining commits once under Other recent commits', () => {
    const groups = buildCommitListGroups(held, recent, { repo: 'api', sha: 'bbbbbbb2222222' });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).toBe('Export');
    expect(groups[0]!.commits.map((c) => c.sha)).toEqual(['bbbbbbb2222222', 'aaaaaaa1111111']);
    expect(groups[0]!.commits[0]).toMatchObject({ fileCount: 3, pushed: false, firstBodyLine: 'Held body' });
    expect(groups[1]!.label).toBe('Other recent commits in api');
    expect(groups[1]!.commits.map((c) => c.sha)).toEqual(['ccccccc']);
  });

  it('keeps an open commit outside recent/held visible in the list', () => {
    const detail: CommitDetail = {
      repo: 'api', sha: 'ddddddd9999', shortSha: 'ddddddd', author: 'Z', at: '2026-11-01T00:00:00Z',
      subject: 'Ancient commit', body: 'Deep history', parents: [], files: [], moreFiles: 0, additions: 0, deletions: 0, pushed: true,
    };
    const groups = buildCommitListGroups(held, recent, { repo: 'api', sha: 'ddddddd9999' }, detail);
    expect(groups[0]!.commits[0]).toMatchObject({ sha: 'ddddddd9999', subject: 'Ancient commit', firstBodyLine: 'Deep history', fileCount: 0, pushed: true });
  });
});

describe('flattenCommitTree and applyCommitTreeKey', () => {
  const held: CommitSequence = {
    label: 'Board',
    commits: [
      { repo: 'api', sha: '1111111aaaaaaa', subject: 'First', at: '2026-11-10T12:00:00Z' },
      { repo: 'api', sha: '2222222bbbbbbb', subject: 'Second', at: '2026-11-10T11:00:00Z' },
    ],
  };
  const files: CommitDetailFile[] = [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
  ];
  const groups = [{ label: 'Board', commits: held.commits }];
  const c1 = { repo: 'api', sha: '1111111aaaaaaa' };
  const c2 = { repo: 'api', sha: '2222222bbbbbbb' };

  it('moves with ArrowRight, ArrowDown, ArrowUp, ArrowLeft, Home, End, and Enter', () => {
    // Open c1 -> files are flattened under c1 only
    let rows = flattenCommitTree(groups, c1, files);
    expect(rows.map((r) => r.kind)).toEqual(['commit', 'file', 'file', 'commit']);

    // ArrowRight on already-open c1 moves into first file
    let next = applyCommitTreeKey(rows, { commit: c1, expanded: c1, file: null, focusId: commitItemId(c1) }, 'ArrowRight');
    expect(next).toMatchObject({ file: 'src/a.ts', focusId: fileItemId(c1, 'src/a.ts'), handled: true });

    // ArrowDown moves to second file, then to c2 without unexpectedly collapsing c1
    next = applyCommitTreeKey(rows, next, 'ArrowDown');
    expect(next.file).toBe('src/b.ts');
    next = applyCommitTreeKey(rows, next, 'ArrowDown');
    expect(next).toMatchObject({ commit: c2, file: null, focusId: commitItemId(c2) });

    // Enter on c2 expands c2 (automatically closing c1 because only 1 commit can be expanded)
    next = applyCommitTreeKey(rows, next, 'Enter');
    expect(next.expanded).toEqual(c2);
    rows = flattenCommitTree(groups, next.expanded, [{ path: 'src/c.ts', status: 'modified', additions: 1, deletions: 0 }]);
    expect(rows.map((r) => r.id)).toEqual([commitItemId(c1), commitItemId(c2), fileItemId(c2, 'src/c.ts')]);

    // End jumps to last item (c2's file), ArrowLeft steps back to c2, second ArrowLeft closes c2
    next = applyCommitTreeKey(rows, next, 'End');
    expect(next).toMatchObject({ commit: c2, file: 'src/c.ts', focusId: fileItemId(c2, 'src/c.ts') });
    next = applyCommitTreeKey(rows, next, 'ArrowLeft');
    expect(next).toMatchObject({ commit: c2, file: null, focusId: commitItemId(c2), expanded: c2 });
    next = applyCommitTreeKey(rows, next, 'ArrowLeft');
    expect(next).toMatchObject({ commit: c2, file: null, focusId: commitItemId(c2), expanded: null });

    // Home jumps to c1
    rows = flattenCommitTree(groups, null, []);
    next = applyCommitTreeKey(rows, next, 'Home');
    expect(next).toMatchObject({ commit: c1, file: null, focusId: commitItemId(c1) });
    expect(next.chosen).toBeUndefined();

    // Enter and Space mark chosen: true on commits and files, unlike arrow movement
    const enterCommit = applyCommitTreeKey(rows, next, 'Enter');
    expect(enterCommit).toMatchObject({ commit: c1, expanded: c1, file: null, chosen: true });
    rows = flattenCommitTree(groups, c1, files);
    const arrowToFile = applyCommitTreeKey(rows, enterCommit, 'ArrowDown');
    expect(arrowToFile.chosen).toBeUndefined();
    const spaceFile = applyCommitTreeKey(rows, arrowToFile, ' ');
    expect(spaceFile).toMatchObject({ commit: c1, expanded: c1, file: 'src/a.ts', chosen: true });
  });
});

describe('buildCommitListGroups with incoming commits', () => {
  it('places incoming commits first newest-first, omits empty incoming repos, and deduplicates once pulled into recent', () => {
    const recent: RecentCommits = {
      at: '2026-10-01T12:00:00Z',
      from: '2026-09-29T12:00:00Z',
      commits: [{
        repo: 'billing',
        more: 0,
        commits: [{ sha: 'aaaaaaa1111', author: 'Alice', subject: 'Local commit', at: '2026-10-01T08:00:00Z', pushed: false }],
      }],
    };
    const incoming = {
      at: '2026-10-01T12:00:00Z',
      repos: [
        {
          repo: 'billing',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'azure' as const, name: 'Azure DevOps' },
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'ok' as const,
          message: null,
          behind: 2,
          commits: [
            { sha: 'bbbbbbb1111', author: 'Bob', subject: 'Older incoming', at: '2026-10-01T09:00:00Z', incoming: true as const, webUrl: 'https://dev.azure.com/o/p/_git/billing/commit/bbbbbbb1111' },
            { sha: 'ccccccc2222', author: 'Maria', subject: 'Newer incoming', at: '2026-10-01T11:00:00Z', incoming: true as const, webUrl: 'https://dev.azure.com/o/p/_git/billing/commit/ccccccc2222' },
          ],
          more: 0,
        },
        {
          repo: 'empty-repo',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'github' as const, name: 'GitHub' },
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'ok' as const,
          message: null,
          behind: 0,
          commits: [],
          more: 0,
        },
      ],
    };

    const groups = buildCommitListGroups(null, recent, null, null, incoming);
    expect(groups.map((g) => g.label)).toEqual(['billing · On Azure DevOps, not in your copy yet', 'Recent commits in billing']);
    expect(groups[0]!.commits.map((c) => [c.sha, c.author, c.incoming])).toEqual([
      ['ccccccc2222', 'Maria', true],
      ['bbbbbbb1111', 'Bob', true],
    ]);

    // After pull: commit ccccccc2222 now sits in recent as well -> leaves incoming cleanly without duplication
    const pulledRecent: RecentCommits = {
      ...recent,
      commits: [{
        repo: 'billing',
        more: 0,
        commits: [
          { sha: 'ccccccc2222', author: 'Maria', subject: 'Newer incoming', at: '2026-10-01T11:00:00Z', pushed: true },
          ...recent.commits[0]!.commits,
        ],
      }],
    };
    const afterPull = buildCommitListGroups(null, pulledRecent, null, null, incoming);
    expect(afterPull[0]!.commits.map((c) => c.sha)).toEqual(['bbbbbbb1111']);
    expect(afterPull[1]!.commits.map((c) => c.sha)).toEqual(['ccccccc2222', 'aaaaaaa1111']);
  });

  it('prefixes incoming group labels with the repository name when multiple repositories exist, and omits it for one repository', () => {
    const singleRepoRecent: RecentCommits = {
      at: '2026-10-01T12:00:00Z',
      from: '2026-09-29T12:00:00Z',
      commits: [{ repo: 'api', more: 0, commits: [] }],
    };
    const singleIncoming = {
      at: '2026-10-01T12:00:00Z',
      repos: [{
        repo: 'api',
        remote: 'origin',
        branch: 'main',
        host: { kind: 'github' as const, name: 'GitHub' },
        lastFetchAt: '2026-10-01T11:59:00Z',
        fetching: false,
        state: 'ok' as const,
        message: null,
        behind: 1,
        commits: [{ sha: 'aaaaaaa1111', author: 'Maria', subject: 'Single repo incoming', at: '2026-10-01T11:00:00Z', incoming: true as const }],
        more: 0,
      }],
    };
    expect(buildCommitListGroups(null, singleRepoRecent, null, null, singleIncoming).map((g) => g.label)).toEqual([
      'On GitHub, not in your copy yet',
    ]);

    const multiIncoming = {
      at: '2026-10-01T12:00:00Z',
      repos: [
        {
          repo: 'api',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'github' as const, name: 'GitHub' },
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'ok' as const,
          message: null,
          behind: 1,
          commits: [{ sha: 'bbbbbbb2222', author: 'Maria', subject: 'API incoming', at: '2026-10-01T11:00:00Z', incoming: true as const }],
          more: 0,
        },
        {
          repo: 'web',
          remote: 'origin',
          branch: 'main',
          host: null,
          lastFetchAt: '2026-10-01T11:59:00Z',
          fetching: false,
          state: 'ok' as const,
          message: null,
          behind: 1,
          commits: [{ sha: 'ccccccc3333', author: 'Bob', subject: 'Web incoming', at: '2026-10-01T10:00:00Z', incoming: true as const }],
          more: 0,
        },
      ],
    };
    expect(buildCommitListGroups(null, singleRepoRecent, null, null, multiIncoming).map((g) => g.label)).toEqual([
      'api · On GitHub, not in your copy yet',
      'web · Not in your copy yet',
    ]);
  });
});

describe('buildCommitRepoGroups, remoteRepoDisplayName, and collapsed group tree navigation', () => {
  it('shows owner/repo only when remote repo leaf name differs from local folder name', () => {
    expect(remoteRepoDisplayName('NexusFlow', 'antan87/Context-Space')).toBe('antan87/Context-Space');
    expect(remoteRepoDisplayName('billing', 'acme/billing')).toBeNull();
    expect(remoteRepoDisplayName('billing', null)).toBeNull();
  });

  it('groups by repo -> branch -> PR with incoming first in repo, unassigned branch commits first, PRs, and onBase last', () => {
    const recent: RecentCommits = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [
        {
          repo: 'NexusFlow',
          remoteRepo: 'antan87/Context-Space',
          branch: 'feat/cl1',
          base: 'main',
          pullRequests: [
            { number: 485, title: 'Open follow-up', state: 'OPEN', url: 'https://github.com/antan87/Context-Space/pull/485' },
            { number: 482, title: 'Merged notes', state: 'MERGED', url: 'https://github.com/antan87/Context-Space/pull/482' },
            { number: 470, title: 'Empty old PR', state: 'CLOSED', url: 'https://github.com/antan87/Context-Space/pull/470' },
          ],
          more: 0,
          commits: [
            { sha: 'unpr001', author: 'A', subject: 'Local commit after PR', at: '2026-11-10T11:30:00Z', pushed: false },
            { sha: 'open001', author: 'A', subject: 'Open PR commit', at: '2026-11-10T11:00:00Z', pushed: true, prNumber: 485 },
            { sha: 'merg001', author: 'A', subject: 'Merged PR commit', at: '2026-11-10T09:00:00Z', pushed: true, prNumber: 482 },
            { sha: 'base001', author: 'M', subject: 'Already merged from main', at: '2026-11-10T08:00:00Z', pushed: true, onBase: true },
          ],
        },
        {
          repo: 'billing',
          remoteRepo: 'acme/billing',
          branch: null,
          base: null,
          more: 0,
          commits: [
            { sha: 'det0001', author: 'B', subject: 'Detached commit', at: '2026-11-10T10:00:00Z', pushed: true },
          ],
        },
      ],
    };
    const incoming: IncomingCommitsReport = {
      at: '2026-11-10T12:00:00Z',
      repos: [
        {
          repo: 'NexusFlow',
          remote: 'origin',
          ref: 'origin/main',
          remoteRepo: 'antan87/Context-Space',
          branch: 'main',
          host: { kind: 'github', name: 'GitHub' },
          lastFetchAt: '2026-11-10T11:59:00Z',
          fetching: false,
          state: 'ok',
          message: null,
          behind: 1,
          commits: [
            { sha: 'inc0001', author: 'Maria', subject: 'Remote fix on main', at: '2026-11-10T11:45:00Z', incoming: true },
          ],
          more: 0,
        },
      ],
    };

    const held: CommitSequence = {
      label: 'Area',
      commits: [{ repo: 'billing', sha: 'det0001' }],
    };

    const repoGroups = buildCommitRepoGroups(held, recent, { repo: 'billing', sha: 'det0001' }, null, incoming);
    // Held repo comes first, then incoming repo
    expect(repoGroups.map((r) => [r.repo, r.remoteRepoLabel])).toEqual([
      ['billing', null],
      ['NexusFlow', 'antan87/Context-Space'],
    ]);

    const billingBranch = repoGroups[0]!.branches[0]!;
    expect(billingBranch.label).toBe('Detached HEAD');
    expect(billingBranch.sections.map((s) => s.kind)).toEqual(['direct']);

    const nexusBranches = repoGroups[1]!.branches;
    expect(nexusBranches.map((b) => [b.kind, b.label])).toEqual([
      ['incoming', 'origin/main'],
      ['local', 'feat/cl1 → main'],
    ]);
    expect(nexusBranches[0]!.statusLabel).toBe('On GitHub, not in your copy yet');
    expect(nexusBranches[1]!.sections.map((s) => [s.kind, s.label, s.pr?.number])).toEqual([
      ['unassigned-pr', 'Not in a pull request yet', undefined],
      ['pr', 'Open follow-up', 485],
      ['pr', 'Merged notes', 482],
      ['on-base', 'Already on main', undefined],
    ]);

    // Drawn order matches [ / ] sequence
    const drawn = flattenRepoGroupCommits(repoGroups);
    expect(drawn.map((c) => c.sha)).toEqual(['det0001', 'inc0001', 'unpr001', 'open001', 'merg001', 'base001']);

    // Ancestors of a PR commit include repo, branch, and PR section
    expect(ancestorGroupIdsForCommit(repoGroups, { repo: 'NexusFlow', sha: 'open001' })).toEqual([
      'repo:NexusFlow',
      'branch:NexusFlow:local:feat/cl1',
      'section:NexusFlow:pr:485',
    ]);

    // Collapsing a PR section skips its commits in flattenCommitTree & keyboard ArrowDown moves across visible groups
    const rowsWithCollapsedPr = flattenCommitTree(repoGroups, null, [], undefined, { 'section:NexusFlow:pr:485': true });
    expect(rowsWithCollapsedPr.map((r) => r.commit.sha)).toEqual(['det0001', 'inc0001', 'unpr001', 'merg001', 'base001']);

    const moved = applyCommitTreeKey(
      rowsWithCollapsedPr,
      { commit: { repo: 'NexusFlow', sha: 'unpr001' }, expanded: null, file: null, focusId: commitItemId({ repo: 'NexusFlow', sha: 'unpr001' }) },
      'ArrowDown',
    );
    expect(moved.commit).toEqual({ repo: 'NexusFlow', sha: 'merg001' });

    // Collapsing a branch or repository skips all nested commits in flattenCommitTree
    const rowsWithCollapsedBranch = flattenCommitTree(repoGroups, null, [], undefined, { 'branch:NexusFlow:incoming:origin/main': true });
    expect(rowsWithCollapsedBranch.map((r) => r.commit.sha)).toEqual(['det0001', 'unpr001', 'open001', 'merg001', 'base001']);

    const rowsWithCollapsedRepo = flattenCommitTree(repoGroups, null, [], undefined, { 'repo:NexusFlow': true });
    expect(rowsWithCollapsedRepo.map((r) => r.commit.sha)).toEqual(['det0001']);
  });

  it('puts a commit the current branch does not list into a neutral "Other commits" group with no branch, and never claims the branch for it', () => {
    const recent: RecentCommits = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [{
        repo: 'NexusFlow',
        remoteRepo: 'antan87/Context-Space',
        branch: 'feat/cl1',
        base: 'main',
        pullRequests: [
          { number: 482, title: 'Merged notes', state: 'MERGED', url: 'https://github.com/antan87/Context-Space/pull/482' },
        ],
        more: 12,
        commits: [
          { sha: 'merg001', author: 'A', subject: 'Merged PR commit', at: '2026-11-10T09:00:00Z', pushed: true, prNumber: 482 },
        ],
      }],
    };
    // Opened from an earlier branch, after switching to feat/cl1: the current branch's results do not list it.
    const held: CommitSequence = {
      label: 'Older news',
      commits: [{ repo: 'NexusFlow', sha: 'old9999', subject: 'Commit from 10 days ago', author: 'A', at: '2026-10-31T10:00:00Z' }],
    };

    const groups = buildCommitRepoGroups(held, recent, { repo: 'NexusFlow', sha: 'cap8888' }, {
      repo: 'NexusFlow',
      sha: 'cap8888',
      shortSha: 'cap8888',
      author: 'A',
      at: '2026-10-30T10:00:00Z',
      subject: 'Commit past 50-commit cap',
      body: '',
      parents: [],
      files: [],
      moreFiles: 0,
      additions: 0,
      deletions: 0,
      pushed: true,
    });
    const [local, other] = groups[0]!.branches;
    expect(local!.kind).toBe('local');
    expect(local!.label).toBe('feat/cl1 → main');
    expect(local!.sections.map((s) => [s.kind, s.label])).toEqual([['pr', 'Merged notes']]);
    expect(local!.sections.flatMap((s) => s.commits.map((c) => c.sha))).toEqual(['merg001']);

    expect(other!.kind).toBe('other');
    expect(other!.label).toBe('Other commits');
    expect(other!.branch).toBeNull();
    expect(other!.base).toBeNull();
    expect(other!.sections.flatMap((s) => s.commits.map((c) => c.sha))).toEqual(['old9999', 'cap8888']);
    // No branch, base or PR is claimed on the commits themselves (the header reads them).
    for (const commit of other!.sections.flatMap((s) => s.commits)) {
      expect(commit.branch).toBeUndefined();
      expect(commit.base).toBeUndefined();
      expect(commit.prNumber).toBeUndefined();
    }
    expect(ancestorGroupIdsForCommit(groups, { repo: 'NexusFlow', sha: 'old9999' })).toEqual([
      'repo:NexusFlow',
      'branch:NexusFlow:other',
    ]);
    const collapsedOther = flattenCommitTree(groups, null, [], undefined, { 'branch:NexusFlow:other': true });
    expect(collapsedOther.map((r) => r.commit.sha)).toEqual(['merg001']);
  });

  it('puts an incoming commit that lies in an open PR range under that PR', () => {
    const prUrl = 'https://github.com/antan87/Context-Space/pull/7';
    const recent: RecentCommits = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [{
        repo: 'NexusFlow',
        branch: 'feat/x',
        base: 'main',
        pullRequests: [{ number: 7, title: 'Shared PR', state: 'OPEN', url: prUrl }],
        incomingPrs: { 'cccc0001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': 7 },
        more: 0,
        commits: [{ sha: 'loca001', author: 'Me', subject: 'Mine', at: '2026-11-10T09:00:00Z' }],
      }],
    };
    const incoming: IncomingCommitsReport = {
      at: '2026-11-10T12:00:00Z',
      repos: [{
        repo: 'NexusFlow', remote: 'origin', ref: 'origin/feat/x', branch: 'feat/x', host: { kind: 'github', name: 'GitHub' },
        lastFetchAt: null, fetching: false, state: 'ok', message: null, behind: 2, more: 0,
        commits: [
          { sha: 'cccc0001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'Sam', subject: 'Colleague push', at: '2026-11-10T11:00:00Z', incoming: true },
          { sha: 'dddd0002bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'Sam', subject: 'Unrelated push', at: '2026-11-10T11:30:00Z', incoming: true },
        ],
      }],
    };
    const groups = buildCommitRepoGroups(null, recent, null, null, incoming);
    const incomingBranch = groups[0]!.branches.find((b) => b.kind === 'incoming')!;
    expect(incomingBranch.sections.map((s) => [s.kind, s.pr?.number ?? null, s.commits.map((c) => c.subject)])).toEqual([
      ['direct', null, ['Unrelated push']],
      ['pr', 7, ['Colleague push']],
    ]);
    const colleague = incomingBranch.sections[1]!.commits[0]!;
    expect(colleague.prNumber).toBe(7);
    expect(colleague.pr?.url).toBe(prUrl);
    expect(flattenRepoGroupCommits(groups).map((c) => c.subject)).toEqual(['Unrelated push', 'Colleague push', 'Mine']);
  });

  it('propagates prsPending from recent repo onto local branch group', () => {
    const recent = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [{
        repo: 'NexusFlow',
        branch: 'feat/cl1',
        base: 'main',
        prsPending: true as const,
        more: 0,
        commits: [
          { sha: 'aaa1111', author: 'A', subject: 'Recent commit', at: '2026-11-10T09:00:00Z', pushed: true },
        ],
      }],
    } as RecentCommits;
    const groups = buildCommitRepoGroups(null, recent, null);
    expect((groups[0]!.branches[0] as { prsPending?: boolean }).prsPending).toBe(true);
    expect(groups[0]!.branches[0]!.sections.map((s) => s.kind)).toEqual(['direct']);
  });

  it('keeps Not in a pull request yet visible while prsPending is true whenever cached PR sections exist', () => {
    const recent: RecentCommits = {
      at: '2026-11-10T12:00:00Z',
      from: '2026-11-07T12:00:00Z',
      commits: [{
        repo: 'NexusFlow',
        branch: 'feat/cl1',
        base: 'main',
        prsPending: true,
        pullRequests: [
          { number: 482, title: 'Merged notes', state: 'MERGED', url: 'https://github.com/antan87/Context-Space/pull/482' },
        ],
        more: 0,
        commits: [
          { sha: 'unpr001', author: 'A', subject: 'Local commit after PR', at: '2026-11-10T11:30:00Z', pushed: false },
          { sha: 'merg001', author: 'A', subject: 'Merged PR commit', at: '2026-11-10T09:00:00Z', pushed: true, prNumber: 482 },
          { sha: 'base001', author: 'M', subject: 'Already merged from main', at: '2026-11-10T08:00:00Z', pushed: true, onBase: true },
        ],
      }],
    };
    const groups = buildCommitRepoGroups(null, recent, { repo: 'NexusFlow', sha: 'merg001' });
    const branch = groups[0]!.branches[0]!;
    expect(branch.prsPending).toBe(true);
    expect(branch.sections.map((s) => [s.id, s.kind, s.label])).toEqual([
      ['section:NexusFlow:unassigned-pr', 'unassigned-pr', 'Not in a pull request yet'],
      ['section:NexusFlow:pr:482', 'pr', 'Merged notes'],
      ['section:NexusFlow:on-base', 'on-base', 'Already on main'],
    ]);
  });
});
