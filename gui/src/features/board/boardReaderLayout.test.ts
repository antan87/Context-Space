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
});
