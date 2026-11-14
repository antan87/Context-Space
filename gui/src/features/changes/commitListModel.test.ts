import { describe, expect, it } from 'vitest';
import type { CommitDetail, CommitDetailFile } from '../board/commitContext.js';
import type { RecentCommits } from '../plan/whatsNew.js';
import {
  applyCommitTreeKey,
  buildCommitListGroups,
  commitItemId,
  fileItemId,
  firstDescriptionLine,
  flattenCommitTree,
  formatCommitStepLabel,
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
