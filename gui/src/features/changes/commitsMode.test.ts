import { describe, expect, it } from 'vitest';
import type { RecentCommits } from '../plan/whatsNew.js';
import { applyCodeRequest, commitKey, composeCommitList, effectiveSequence, neighbourCommit, newestRecentCommit, positionText, sameCommit, type CommitSequence } from './commitsMode.js';

const row: CommitSequence = {
  label: 'Board reader',
  commits: [
    { repo: 'app', sha: 'aaaaaaa1111', subject: 'newest of the row' },
    { repo: 'app', sha: 'bbbbbbb2222', subject: 'middle' },
    { repo: 'app', sha: 'ccccccc3333', subject: 'oldest of the row' },
  ],
};

const recent: RecentCommits = {
  at: '2026-11-13T10:00:00Z',
  from: '2026-11-10T10:00:00Z',
  commits: [
    { repo: 'app', more: 0, commits: [
      { sha: 'aaaaaaa1111999', subject: 'newest of the row', author: 'a', at: '2026-11-13T09:00:00Z' },
      { sha: 'ddddddd4444', subject: 'elsewhere in app', author: 'a', at: '2026-11-12T09:00:00Z' },
      { sha: 'bbbbbbb2222888', subject: 'middle', author: 'a', at: '2026-11-11T09:00:00Z' },
    ] },
    { repo: 'api', more: 0, commits: [
      { sha: 'aaaaaaa7777', subject: 'same prefix, other repo', author: 'b', at: '2026-11-13T09:30:00Z' },
    ] },
  ],
};

describe('sameCommit', () => {
  it('matches a short SHA against the full one, in the same repository', () => {
    expect(sameCommit({ repo: 'app', sha: 'aaaaaaa' }, { repo: 'app', sha: 'aaaaaaa1111999' })).toBe(true);
  });
  it('keeps the same prefix in two repositories apart', () => {
    expect(sameCommit({ repo: 'app', sha: 'aaaaaaa1111' }, { repo: 'api', sha: 'aaaaaaa1111' })).toBe(false);
    expect(commitKey({ repo: 'app', sha: 'aaaaaaa1111' })).not.toBe(commitKey({ repo: 'api', sha: 'aaaaaaa1111' }));
  });
  it('does not match different commits or missing ones', () => {
    expect(sameCommit({ repo: 'app', sha: 'aaaaaaa1111' }, { repo: 'app', sha: 'bbbbbbb2222' })).toBe(false);
    expect(sameCommit(null, { repo: 'app', sha: 'aaaaaaa1111' })).toBe(false);
  });
});

describe('neighbourCommit: [ and ] follow the row in the order it shows', () => {
  it('goes to the next and previous commit of the row', () => {
    expect(neighbourCommit(row, { repo: 'app', sha: 'bbbbbbb2222' }, 1)?.sha).toBe('ccccccc3333');
    expect(neighbourCommit(row, { repo: 'app', sha: 'bbbbbbb2222' }, -1)?.sha).toBe('aaaaaaa1111');
  });
  it('stops at both ends', () => {
    expect(neighbourCommit(row, { repo: 'app', sha: 'aaaaaaa1111' }, -1)).toBeNull();
    expect(neighbourCommit(row, { repo: 'app', sha: 'ccccccc3333' }, 1)).toBeNull();
  });
  it('finds the commit by a short SHA and never in another repository', () => {
    expect(neighbourCommit(row, { repo: 'app', sha: 'bbbbbbb' }, 1)?.sha).toBe('ccccccc3333');
    expect(neighbourCommit(row, { repo: 'api', sha: 'bbbbbbb2222' }, 1)).toBeNull();
  });
});

describe('positionText', () => {
  it('says where the commit stands in its row', () => {
    expect(positionText(row, { repo: 'app', sha: 'bbbbbbb2222' })).toBe('2 of 3 · Board reader');
  });
  it('says nothing without a row or for a commit outside it', () => {
    expect(positionText(null, { repo: 'app', sha: 'bbbbbbb2222' })).toBe('');
    expect(positionText(row, { repo: 'app', sha: 'ddddddd4444' })).toBe('');
  });
});

describe('effectiveSequence', () => {
  it('keeps the row the commit was opened from while the commit is in it', () => {
    expect(effectiveSequence({ repo: 'app', sha: 'bbbbbbb2222' }, row, recent)).toBe(row);
  });
  it('falls back to the recent commits of the commit\'s own repository, newest first, for one chosen from the list', () => {
    const own = effectiveSequence({ repo: 'app', sha: 'ddddddd4444' }, row, recent);
    expect(own?.label).toBe('app');
    expect(own?.commits.map((commit) => commit.sha)).toEqual(['aaaaaaa1111999', 'ddddddd4444', 'bbbbbbb2222888']);
  });
  it('is nothing when the commit is in no list', () => {
    expect(effectiveSequence({ repo: 'app', sha: 'eeeeeee5555' }, null, recent)).toBeNull();
    expect(effectiveSequence(null, row, recent)).toBeNull();
  });
});

describe('composeCommitList', () => {
  it('lists the row first, then the other recent commits of each repository, each commit once', () => {
    const groups = composeCommitList(row, recent);
    expect(groups.map((group) => group.label)).toEqual(['Board reader', 'Other recent commits in app', 'Other recent commits in api']);
    expect(groups[0]!.commits).toHaveLength(3);
    expect(groups[1]!.commits.map((commit) => commit.sha)).toEqual(['ddddddd4444']);
    // the same short prefix in another repository is a different commit, so it stays
    expect(groups[2]!.commits.map((commit) => commit.sha)).toEqual(['aaaaaaa7777']);
  });
  it('without a row, lists the recent commits per repository', () => {
    const groups = composeCommitList(null, recent);
    expect(groups.map((group) => group.label)).toEqual(['Recent commits in app', 'Recent commits in api']);
    expect(groups[0]!.commits).toHaveLength(3);
  });
  it('is empty when there is nothing', () => {
    expect(composeCommitList(null, undefined)).toEqual([]);
  });
});

describe('newestRecentCommit', () => {
  it('is the newest commit over all repositories', () => {
    expect(newestRecentCommit(recent)).toMatchObject({ repo: 'api', sha: 'aaaaaaa7777' });
  });
  it('is nothing without commits', () => {
    expect(newestRecentCommit(undefined)).toBeNull();
    expect(newestRecentCommit({ ...recent, commits: [] })).toBeNull();
  });
});

describe('applyCodeRequest (the mode state)', () => {
  const closed = { open: false, commit: null, held: null };
  it('opens Commits on the commit asked for, with its row', () => {
    expect(applyCodeRequest(closed, { repo: 'app', sha: 'bbbbbbb2222', sequence: row })).toEqual({ open: true, commit: { repo: 'app', sha: 'bbbbbbb2222' }, held: row });
  });
  it('a request without a commit (the Code button, a file) leaves Commits but keeps the commit for the way back', () => {
    const open = applyCodeRequest(closed, { repo: 'app', sha: 'bbbbbbb2222', sequence: row });
    const left = applyCodeRequest(open, undefined);
    expect(left.open).toBe(false);
    expect(left.commit).toEqual({ repo: 'app', sha: 'bbbbbbb2222' });
    expect(applyCodeRequest(closed, undefined)).toBe(closed);
  });
});
