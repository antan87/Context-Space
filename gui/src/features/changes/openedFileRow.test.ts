import { describe, expect, it } from 'vitest';
import { OPENED_UNLISTED, withOpenedFile } from './openedFileRow.js';

const repos = [
  { repoName: 'api', files: [{ file: 'src/a.ts', type: 'unchanged' }] },
  { repoName: 'web', files: [{ file: 'src/b.ts', type: 'unchanged' }], error: undefined },
];

describe('withOpenedFile', () => {
  it('adds the opened file to its repository when the listing leaves it out', () => {
    const result = withOpenedFile(repos, { repoName: 'api', file: 'dist/out.js' });
    expect(result[0]!.files).toEqual([{ file: 'src/a.ts', type: 'unchanged' }, { file: 'dist/out.js', type: OPENED_UNLISTED }]);
    // Only that repository, and the listing itself is not changed.
    expect(result[1]).toBe(repos[1]);
    expect(repos[0]!.files).toHaveLength(1);
  });

  it('leaves the listing alone when the file is listed, nothing is open, or the repository is unknown or failed', () => {
    expect(withOpenedFile(repos, { repoName: 'api', file: 'src/a.ts' })).toEqual(repos);
    expect(withOpenedFile(repos, null)).toEqual(repos);
    expect(withOpenedFile(repos, undefined)).toEqual(repos);
    expect(withOpenedFile(repos, { repoName: 'ghost', file: 'x.ts' })).toEqual(repos);
    const failed = [{ repoName: 'api', files: [], error: 'git failed' }];
    expect(withOpenedFile(failed, { repoName: 'api', file: 'dist/out.js' })).toEqual(failed);
  });

  it('does not take a file of another repository for the same name', () => {
    const result = withOpenedFile(repos, { repoName: 'web', file: 'src/a.ts' });
    expect(result[0]!.files).toHaveLength(1);
    expect(result[1]!.files.map((entry) => entry.file)).toEqual(['src/b.ts', 'src/a.ts']);
  });
});
