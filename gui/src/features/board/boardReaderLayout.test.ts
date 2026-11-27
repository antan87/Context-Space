import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LARGE_WINDOW,
  LAYOUT_KEY,
  cleanLayout,
  readLayout,
  writeLayout,
  isSameReaderTarget,
  collectAreaReaderTargets,
  findReaderTargetIndex,
  pictureFallback,
} from './boardReaderLayout.js';
import type { BoardArea } from './boardAreas.js';

/** A storage the spec holds, standing in for the browser's. */
function stubStorage(initial: Record<string, string> = {}, fails = false) {
  const data = new Map(Object.entries(initial));
  const refuse = () => { throw new Error('Storage is not available.'); };
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => (fails ? refuse() : data.get(key) ?? null),
    setItem: (key: string, value: string) => (fails ? refuse() : void data.set(key, value)),
  } });
  return data;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the large window', () => {
  it('takes about 92% of the section\'s width and 88% of its height, and leaves the board in sight all round', () => {
    expect(LARGE_WINDOW).toEqual({ width: 0.92, height: 0.88 });
    expect((1 - LARGE_WINDOW.width) / 2 * 1440).toBeGreaterThan(40);
  });
});

describe('cleanLayout', () => {
  it('is the dock only when that is what was kept, and the large window for anything else', () => {
    expect(cleanLayout('side')).toBe('side');
    expect(cleanLayout('large')).toBe('large');
    for (const odd of [null, undefined, '', 'Side', 'docked', 0, {}, ['side']]) expect(cleanLayout(odd)).toBe('large');
  });
});

describe('the kept layout', () => {
  it('is the large window until the viewer chooses', () => {
    stubStorage();
    expect(readLayout()).toBe('large');
  });

  it('is what the viewer chose, read back', () => {
    const data = stubStorage();
    writeLayout('side');
    expect(data.get(LAYOUT_KEY)).toBe('side');
    expect(readLayout()).toBe('side');
    writeLayout('large');
    expect(readLayout()).toBe('large');
  });

  it('ignores what it cannot make sense of', () => {
    stubStorage({ [LAYOUT_KEY]: '{"layout":"side"}' });
    expect(readLayout()).toBe('large');
  });

  it('shows the large window and does not fail when storage is not there to read or write', () => {
    stubStorage({}, true);
    expect(readLayout()).toBe('large');
    expect(() => writeLayout('side')).not.toThrow();
    vi.stubGlobal('window', {});
    expect(readLayout()).toBe('large');
    expect(() => writeLayout('side')).not.toThrow();
  });
});

describe('isSameReaderTarget', () => {
  it('identifies identical commits by repo and sha regardless of path formatting', () => {
    const a = { path: 'NexusFlow · abc1234', title: 'Commit A', commit: { repo: 'NexusFlow', sha: 'abc1234' } };
    const b = { path: 'other/path', title: 'Commit B', commit: { repo: 'NexusFlow', sha: 'abc1234' } };
    const c = { path: 'NexusFlow · def5678', title: 'Commit C', commit: { repo: 'NexusFlow', sha: 'def5678' } };
    expect(isSameReaderTarget(a, b)).toBe(true);
    expect(isSameReaderTarget(a, c)).toBe(false);
  });

  it('differentiates commits from plain documents or files', () => {
    const commit = { path: 'file.md', title: 'Commit', commit: { repo: 'r', sha: '123' } };
    const doc = { path: 'file.md', title: 'Doc' };
    expect(isSameReaderTarget(commit, doc)).toBe(false);
    expect(isSameReaderTarget(doc, commit)).toBe(false);
  });

  it('distinguishes the same file path across workspace, repositories and sources', () => {
    const local = { path: 'docs/guide.md', title: 'Guide' };
    const api = { ...local, repo: { name: 'api', path: '/repos/api' } };
    const web = { ...local, repo: { name: 'web', path: '/repos/web' } };
    expect(isSameReaderTarget(local, api)).toBe(false);
    expect(isSameReaderTarget(api, web)).toBe(false);
    expect(isSameReaderTarget(api, { ...api })).toBe(true);
    expect(isSameReaderTarget(local, { ...local, source: 'source-1' })).toBe(false);
  });

  it('identifies source documents by source ID', () => {
    const a = { path: 'PLAN.md', title: 'Plan', source: 'src-1' };
    const b = { path: 'different.md', title: 'Plan', source: 'src-1' };
    const c = { path: 'PLAN.md', title: 'Plan', source: 'src-2' };
    expect(isSameReaderTarget(a, b)).toBe(true);
    expect(isSameReaderTarget(a, c)).toBe(false);
  });

  it('identifies card files by card ID or path', () => {
    const a = { path: 'pic.png', title: 'Picture', card: 'card-1' };
    const b = { path: 'pic.png', title: 'Picture', card: 'card-1' };
    const c = { path: 'pic.png', title: 'Picture', card: 'card-2' };
    expect(isSameReaderTarget(a, b)).toBe(true);
    expect(isSameReaderTarget(a, c)).toBe(false);

    const noCardA = { path: 'pic.png', title: 'Picture' };
    const noCardB = { path: 'pic.png', title: 'Picture' };
    const noCardC = { path: 'other.png', title: 'Other' };
    expect(isSameReaderTarget(noCardA, noCardB)).toBe(true);
    expect(isSameReaderTarget(noCardA, noCardC)).toBe(false);
  });
});

describe('collectAreaReaderTargets', () => {
  it('collects source documents and cards in order, deduplicates, and leaves commits out (they open in the Code window)', () => {
    const mockArea: BoardArea = {
      id: 'area-1',
      kind: 'checkpoint',
      data: {
        id: 'area-1',
        title: 'Area 1',
        kind: 'checkpoint',
        done: false,
        current: true,
        waitingCount: 0,
        stepsTotal: 1,
        stepsDone: 0,
        fresh: false,
        sinceNews: null,
      },
      documents: [
        {
          id: 'doc-1',
          title: 'Plan Spec',
          role: 'requirements',
          status: 'current',
          filename: 'PLAN.md',
          summary: 'The plan',
        },
        {
          id: 'doc-2',
          title: 'Link Doc (no filename)',
          role: 'reference',
          status: 'current',
          summary: 'Link doc',
        },
      ],
      cards: [
        {
          id: 'card-pic-1',
          kind: 'file',
          path: 'board-pictures/live.png',
          title: 'Live Screenshot',
          description: 'A screenshot',
          by: 'ai',
          at: '2026-11-03T18:00:00Z',
          updatedBy: 'ai',
          updatedAt: '2026-11-03T18:00:00Z',
          pinned: false,
        },
        {
          id: 'card-note-1',
          kind: 'note',
          title: 'A note',
          body: 'Note body',
          by: 'user',
          at: '2026-11-03T18:00:00Z',
          updatedBy: 'user',
          updatedAt: '2026-11-03T18:00:00Z',
          pinned: false,
        },
      ],
      repos: [
        {
          repo: { repo: 'NexusFlow', commits: [], more: 0 },
          laneId: 'lane-1',
          cards: [{ id: 'commit:NexusFlow:1111111' }],
          commits: [
            {
              sha: '11111112222222',
              subject: 'feat: add awesome feature',
              author: 'Anton',
              at: '2026-11-03T18:10:00Z',
              pushed: true,
            },
          ],
        },
      ],
      archivedCount: 0,
      allMemberNodeIds: ['area-1', 'card-pic-1'],
    };

    const targets = collectAreaReaderTargets(mockArea);
    expect(targets).toHaveLength(2);
    expect(targets.some((target) => target.commit)).toBe(false);
    // 1. Document
    expect(targets[0]).toMatchObject({
      path: 'PLAN.md',
      title: 'Plan Spec',
      source: 'doc-1',
    });
    // 2. Picture card
    expect(targets[1]).toMatchObject({
      path: 'board-pictures/live.png',
      title: 'Live Screenshot',
      card: 'card-pic-1',
    });

    // Test findReaderTargetIndex
    expect(findReaderTargetIndex(targets, targets[1]!)).toBe(1);
    expect(findReaderTargetIndex(targets, { path: 'nonexistent' } as any)).toBe(-1);
  });

  it('collects step-scoped pictures with own titles and In step/In folder footers, matching duplicate paths by card id', () => {
    const areaWithStepPics: BoardArea = {
      id: 'checkpoint:cp-px1',
      kind: 'checkpoint',
      data: {
        kind: 'checkpoint',
        title: 'Pictures',
        noteCount: 0,
        fileCount: 3,
        pictureCount: 3,
        commitCount: 0,
        docCount: 0,
        decisionCount: 0,
        openDecisionCount: 0,
        stepsDone: 0,
        stepsTotal: 2,
        pictures: [],
        done: false,
        current: true,
        nowSet: false,
        fresh: false,
      },
      cards: [],
      planItems: {
        steps: [
          { key: 's1', text: 'First step: Capture `board-pictures/shared.png`', done: false },
          { key: 's2', text: 'Second step: Compare `board-pictures/shared.png` and `board-pictures/s2-only.png`', done: false },
        ],
        decisions: [],
        waitingKeys: [],
        counts: { total: 2, done: 0, waiting: 0, decisions: 0, openDecisions: 0 },
      },
      stepFiles: {
        s1: [{ path: 'board-pictures/shared.png', name: 'shared.png', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' }],
        s2: [
          { path: 'board-pictures/shared.png', name: 'shared.png', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' },
          { path: 'board-pictures/s2-only.png', name: 's2-only.png', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' },
        ],
      },
      documents: [],
      commits: [],
      archivedCount: 0,
      allMemberNodeIds: [],
    };

    const stepTargets = collectAreaReaderTargets(areaWithStepPics);
    expect(stepTargets[0]).toMatchObject({
      path: 'board-pictures/shared.png',
      title: 'shared',
      card: 'wsfile:step:s1:board-pictures/shared.png',
      stepKey: 's1',
      text: 'In step: First step: Capture board-pictures/shared.png',
    });
    expect(stepTargets[1]).toMatchObject({
      path: 'board-pictures/shared.png',
      title: 'shared',
      card: 'wsfile:step:s2:board-pictures/shared.png',
      stepKey: 's2',
      text: 'In step: Second step: Compare board-pictures/shared.png and…',
    });
    expect(findReaderTargetIndex(stepTargets, {
      path: 'board-pictures/shared.png',
      title: 'shared',
      card: 'wsfile:step:s2:board-pictures/shared.png',
    })).toBe(1);

    const wsArea: BoardArea = {
      id: 'files:workspace',
      kind: 'files',
      data: {
        kind: 'files',
        title: 'Workspace files',
        noteCount: 0,
        fileCount: 2,
        pictureCount: 2,
        commitCount: 0,
        docCount: 0,
        decisionCount: 0,
        openDecisionCount: 0,
        stepsDone: 0,
        stepsTotal: 0,
        pictures: [],
        done: false,
        current: false,
        nowSet: false,
        fresh: false,
      },
      cards: [],
      workspaceFiles: {
        documents: [],
        pages: [],
        pictures: [
          { path: 'board-pictures/loose.png', name: 'loose.png', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' },
          { path: 'root-pic.png', name: 'root-pic.png', folder: '', fileType: 'image', group: 'pictures', modifiedAt: '' },
        ],
      },
      documents: [],
      commits: [],
      archivedCount: 0,
      allMemberNodeIds: [],
    };
    const wsTargets = collectAreaReaderTargets(wsArea);
    expect(wsTargets[0]).toMatchObject({ path: 'board-pictures/loose.png', title: 'loose', text: 'In folder: board-pictures' });
    expect(wsTargets[1]).toMatchObject({ path: 'root-pic.png', title: 'root-pic', text: 'Workspace root' });
  });

  it('PX1: BoardCard folder fallback never leaks into footers, strips raw picture extension, and collects svg step pictures', () => {
    const areaWithBoardCard: BoardArea = {
      id: 'checkpoint:cp',
      kind: 'checkpoint',
      data: {
        kind: 'checkpoint',
        title: 'Checkpoint Alpha',
        noteCount: 0,
        fileCount: 3,
        pictureCount: 3,
        commitCount: 0,
        docCount: 0,
        decisionCount: 0,
        openDecisionCount: 0,
        stepsDone: 0,
        stepsTotal: 1,
        pictures: [],
        done: false,
        current: false,
        nowSet: false,
        fresh: false,
      },
      planItems: {
        steps: [{ key: 's1', line: 3, text: 'Capture mock (18 Nov; pictures `board-pictures/shot.png`)', done: false, kind: 'step', indent: 0 }],
        decisions: [],
      },
      cards: [
        { id: 'c-step', kind: 'file', path: 'board-pictures/shot.png', title: 'shot.png', description: 'board-pictures', step: 's1', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', createdBy: 'claude', archived: false },
        { id: 'c-area', kind: 'file', path: 'board-pictures/loose-card.png', title: 'loose-card.png', description: 'In folder: board-pictures', createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z', createdBy: 'claude', archived: false },
      ],
      stepFiles: {
        s1: [{ path: 'board-pictures/arch.svg', name: 'arch', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' }],
      },
      documents: [],
      commits: [],
      archivedCount: 0,
      allMemberNodeIds: [],
    };
    const targets = collectAreaReaderTargets(areaWithBoardCard);
    expect(targets.find((t) => t.card === 'c-step')).toMatchObject({ title: 'shot', text: 'In step: Capture mock (18 Nov)', stepKey: 's1' });
    expect(targets.find((t) => t.card === 'c-area')).toMatchObject({ title: 'loose-card', text: 'Checkpoint Alpha' });
    expect(targets.find((t) => t.card === 'wsfile:step:s1:board-pictures/arch.svg')).toMatchObject({ title: 'arch', stepKey: 's1', text: 'In step: Capture mock (18 Nov)' });
  });

  it('PX1: pictureFallback drops picture extensions and computes folder/repo footers for unmatched pictures', () => {
    expect(pictureFallback('board-pictures/shot.png')).toEqual({
      title: 'shot',
      text: 'In folder: board-pictures',
    });
    expect(pictureFallback('./root-shot.svg')).toEqual({
      title: 'root-shot',
      text: 'Workspace root',
    });
    expect(pictureFallback('assets/repo-diagram.svg', { name: 'api' })).toEqual({
      title: 'repo-diagram',
      text: 'In folder: assets',
    });
    expect(pictureFallback('repo-root.png', { name: 'api' })).toEqual({
      title: 'repo-root',
      text: 'api',
    });
  });

  it('PX1 fix1: a card with an unknown card.step gets no stepKey and no In step footer', () => {
    const areaWithOrphanCard: BoardArea = {
      id: 'checkpoint:cp-orphan',
      kind: 'checkpoint',
      data: {
        kind: 'checkpoint',
        title: 'Board tab real work',
        noteCount: 0,
        fileCount: 2,
        pictureCount: 2,
        commitCount: 0,
        docCount: 0,
        decisionCount: 0,
        openDecisionCount: 0,
        stepsDone: 1,
        stepsTotal: 1,
        pictures: [],
        done: true,
        current: false,
        nowSet: false,
        fresh: false,
      },
      planItems: {
        steps: [{ key: 's-real', text: 'Real step still here', done: true }],
        decisions: [],
      },
      cards: [
        {
          id: 'c-orphan',
          kind: 'file',
          path: 'board-pictures/commit-reader.png',
          title: 'Commit reader',
          description: 'board-pictures',
          step: 'stale-deleted-step',
          by: 'claude',
          at: '2026-11-01T10:00:00Z',
          updatedBy: 'claude',
          updatedAt: '2026-11-01T10:00:00Z',
          pinned: false,
          archived: false,
        },
        {
          id: 'c-valid',
          kind: 'file',
          path: 'board-pictures/valid-shot.png',
          title: 'Valid shot',
          description: '',
          step: 's-real',
          by: 'claude',
          at: '2026-11-02T10:00:00Z',
          updatedBy: 'claude',
          updatedAt: '2026-11-02T10:00:00Z',
          pinned: false,
          archived: false,
        },
      ],
      documents: [],
      commits: [],
      archivedCount: 0,
      allMemberNodeIds: [],
    };

    const targets = collectAreaReaderTargets(areaWithOrphanCard);
    const orphan = targets.find((t) => t.card === 'c-orphan');
    const valid = targets.find((t) => t.card === 'c-valid');
    expect(orphan).toBeDefined();
    expect(orphan?.stepKey).toBeUndefined();
    expect(orphan?.text).toBe('Board tab real work');
    expect(orphan?.text).not.toContain('In step:');
    expect(valid).toMatchObject({ stepKey: 's-real', text: 'In step: Real step still here' });
  });

  it('PX1 fix1: two step cards (one pinned) plus a step file come out in the row order', () => {
    const areaWithMixedStep: BoardArea = {
      id: 'checkpoint:cp-mixed',
      kind: 'checkpoint',
      data: {
        kind: 'checkpoint',
        title: 'Mixed step',
        noteCount: 0,
        fileCount: 3,
        pictureCount: 3,
        commitCount: 0,
        docCount: 0,
        decisionCount: 0,
        openDecisionCount: 0,
        stepsDone: 0,
        stepsTotal: 1,
        pictures: [],
        done: false,
        current: true,
        nowSet: true,
        fresh: false,
      },
      planItems: {
        steps: [{ key: 's1', text: 'Mixed step Pictures: `board-pictures/s1-file.png`', done: false }],
        decisions: [],
      },
      cards: [
        {
          id: 'c-older-unpinned',
          kind: 'file',
          path: 'board-pictures/older.png',
          title: 'Older unpinned',
          description: 'First created',
          step: 's1',
          by: 'user',
          at: '2026-11-01T10:00:00Z',
          updatedBy: 'user',
          updatedAt: '2026-11-01T10:00:00Z',
          pinned: false,
          archived: false,
        },
        {
          id: 'c-newer-pinned',
          kind: 'file',
          path: 'board-pictures/pinned.png',
          title: 'Newer pinned',
          description: 'Pinned on left',
          step: 's1',
          by: 'user',
          at: '2026-11-02T10:00:00Z',
          updatedBy: 'user',
          updatedAt: '2026-11-02T10:00:00Z',
          pinned: true,
          archived: false,
        },
      ],
      stepFiles: {
        s1: [
          { path: 'board-pictures/s1-file.png', name: 's1-file.png', folder: 'board-pictures', fileType: 'image', group: 'pictures', modifiedAt: '' },
        ],
      },
      documents: [],
      commits: [],
      archivedCount: 0,
      allMemberNodeIds: [],
    };

    const targets = collectAreaReaderTargets(areaWithMixedStep, 's1');
    expect(targets.map((t) => t.card)).toEqual([
      'c-newer-pinned',
      'c-older-unpinned',
      'wsfile:step:s1:board-pictures/s1-file.png',
    ]);
  });
});
