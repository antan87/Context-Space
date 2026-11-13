import { describe, expect, it } from 'vitest';
import type { BoardArea } from './boardAreas.js';
import { commitOpenFor } from './commitSequence.js';

const commit = (sha: string, subject: string) => ({ sha, subject, author: 'a', at: '2026-11-13T09:00:00Z' });
const area = (title: string, repos: { name: string; shas: string[] }[]): BoardArea => ({
  id: `area:${title}`,
  kind: 'work',
  data: { title } as BoardArea['data'],
  documents: [],
  cards: [],
  archivedCount: 0,
  allMemberNodeIds: [],
  repos: repos.map((repo, index) => ({
    repo: { repo: repo.name, commits: [], more: 0 },
    laneId: `lane:commits:${index}`,
    commits: repo.shas.map((sha) => commit(sha, `subject ${sha}`)),
    cards: repo.shas.map((sha) => ({ id: `commit:${repo.name}:${sha}` })) as never,
  })),
});

describe('commitOpenFor', () => {
  const areas = [
    area('Reader', [{ name: 'app', shas: ['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'] }]),
    area('Search', [{ name: 'app', shas: ['ddddddd4'] }, { name: 'api', shas: ['aaaaaaa1', 'eeeeeee5'] }]),
  ];
  it('is nothing for a target that is not a commit', () => {
    expect(commitOpenFor(areas, { path: 'a.md', title: 'A' })).toBeNull();
  });
  it('sends the commits of the row in the order the row shows them, named by its Area', () => {
    const open = commitOpenFor(areas, { path: 'app · bbbbbbb', title: 's', card: 'commit:app:bbbbbbb2', commit: { repo: 'app', sha: 'bbbbbbb2' } });
    expect(open?.sequence?.label).toBe('Reader');
    expect(open?.sequence?.commits.map((entry) => entry.sha)).toEqual(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3']);
  });
  it('keeps the same short SHA in two repositories apart', () => {
    const open = commitOpenFor(areas, { path: 'api · aaaaaaa', title: 's', card: 'commit:api:aaaaaaa1', commit: { repo: 'api', sha: 'aaaaaaa1' } });
    expect(open?.repo).toBe('api');
    expect(open?.sequence?.label).toBe('Search');
    expect(open?.sequence?.commits.map((entry) => `${entry.repo}:${entry.sha}`)).toEqual(['api:aaaaaaa1', 'api:eeeeeee5']);
  });
  it('still opens a commit that no row holds, without a sequence', () => {
    expect(commitOpenFor(areas, { path: 'app · fffffff', title: 's', commit: { repo: 'app', sha: 'fffffff6' } })).toEqual({ repo: 'app', sha: 'fffffff6' });
  });
});
