import { describe, expect, it } from 'vitest';
import { areaCountItems, resolveCountTarget } from './boardCountNav.js';
import { cardFooterHeight, type AreaData, type BoardArea } from './boardAreas.js';
import { areaPlace } from './boardRows.js';
import type { BoardCard } from './boardData.js';

describe('boardCountNav', () => {
  const bareData: AreaData = {
    kind: 'checkpoint',
    title: 'Checkpoint 1',
    done: false,
    current: true,
    nowSet: true,
    stepsDone: 0,
    stepsTotal: 2,
    waitingCount: 0,
    noteCount: 0,
    fileCount: 0,
    pictureCount: 0,
    documentCount: 0,
    commitCount: 0,
    archivedCount: 0,
    pictures: [],
    fresh: false,
  };

  const bareArea: BoardArea = {
    id: 'checkpoint:cp1',
    kind: 'checkpoint',
    title: 'Checkpoint 1',
    steps: [
      { key: 's1', text: 'Step 1', done: false },
      { key: 's2', text: 'Step 2', done: false },
    ],
    cards: [],
    documents: [],
    repos: [{ repo: { repo: 'api', count: 3, more: 0, commits: [] }, commits: [], commitNodeIds: [], laneId: 'lane:commits:api', cards: [] }],
    data: bareData,
  };

  describe('areaCountItems', () => {
    it('returns empty array when counts are zero', () => {
      expect(areaCountItems(bareData)).toEqual([]);
    });

    it('returns items with pluralized labels and action names', () => {
      const data: AreaData = {
        ...bareData,
        noteCount: 2,
        pictureCount: 38,
        fileCount: 41, // 38 pictures + 3 other files
        documentCount: 3,
        commitCount: 5,
        updateCount: 1,
      };
      const items = areaCountItems(data);
      expect(items).toEqual([
        { kind: 'notes', count: 2, label: '2 notes', actionLabel: 'Show the 2 notes' },
        { kind: 'pictures', count: 38, label: '38 pictures', actionLabel: 'Show the 38 pictures' },
        { kind: 'files', count: 3, label: '3 files', actionLabel: 'Show the 3 files' },
        { kind: 'documents', count: 3, label: '3 documents', actionLabel: 'Show the 3 documents' },
        { kind: 'commits', count: 5, label: '5 commits', actionLabel: 'Show the 5 commits' },
        { kind: 'updates', count: 1, label: '1 update', actionLabel: 'Show the 1 update' },
      ]);
    });

    it('handles singular counts properly', () => {
      const data: AreaData = {
        ...bareData,
        noteCount: 1,
        pictureCount: 1,
        fileCount: 2,
        documentCount: 1,
        commitCount: 1,
        updateCount: 2,
      };
      const items = areaCountItems(data);
      expect(items).toEqual([
        { kind: 'notes', count: 1, label: '1 note', actionLabel: 'Show the 1 note' },
        { kind: 'pictures', count: 1, label: '1 picture', actionLabel: 'Show the 1 picture' },
        { kind: 'files', count: 1, label: '1 file', actionLabel: 'Show the 1 file' },
        { kind: 'documents', count: 1, label: '1 document', actionLabel: 'Show the 1 document' },
        { kind: 'commits', count: 1, label: '1 commit', actionLabel: 'Show the 1 commit' },
        { kind: 'updates', count: 2, label: '2 updates', actionLabel: 'Show the 2 updates' },
      ]);
    });
  });

  describe('resolveCountTarget', () => {
    it('maps pictures count to lane:board on Media tab', () => {
      const target = resolveCountTarget(bareArea, 'pictures');
      expect(target).toEqual({ rowId: 'lane:board', tab: 'media' });
    });

    it('maps notes count to lane:board on Notes tab', () => {
      const target = resolveCountTarget(bareArea, 'notes');
      expect(target).toEqual({ rowId: 'lane:board', tab: 'notes' });
    });

    it('maps files count to board lane Media tab when board file cards exist even if documents exist', () => {
      const areaWithBoth: BoardArea = {
        ...bareArea,
        cards: [
          { id: 'f1', kind: 'file', path: 'data.csv', title: 'Data CSV', pinned: false, archived: false, by: 'dev', at: '2026-10-01T00:00:00Z' },
        ],
        documents: [{ id: 'doc1', title: 'Doc 1', role: 'design', status: 'approved', scope: {}, summary: '', createdAt: '', updatedAt: '' }],
      };
      const target = resolveCountTarget(areaWithBoth, 'files');
      expect(target).toEqual({ rowId: 'lane:board', tab: 'media', cardId: 'f1' });
    });

    it('maps files count to step row when file card is tied to a step', () => {
      const areaWithStepFile: BoardArea = {
        ...bareArea,
        cards: [
          { id: 'f2', kind: 'file', path: 'report.pdf', title: 'Report', step: 's1', pinned: false, archived: false, by: 'dev', at: '2026-10-01T00:00:00Z' },
        ],
      };
      const target = resolveCountTarget(areaWithStepFile, 'files');
      expect(target).toEqual({ rowId: 'row:step:s1', stepKey: 's1', cardId: 'f2' });
    });

    it('maps files count to documents row as fallback when no board file cards exist', () => {
      const areaWithOnlyDocs: BoardArea = {
        ...bareArea,
        cards: [],
        documents: [{ id: 'doc1', title: 'Doc 1', role: 'design', status: 'approved', scope: {}, summary: '', createdAt: '', updatedAt: '' }],
      };
      const target = resolveCountTarget(areaWithOnlyDocs, 'files');
      expect(target).toEqual({ rowId: 'lane:documents' });
    });

    it('maps files count to lane:board Media tab when no documents exist', () => {
      const target = resolveCountTarget(bareArea, 'files');
      expect(target).toEqual({ rowId: 'lane:board', tab: 'media' });
    });

    it('maps documents count to documents row', () => {
      const target = resolveCountTarget(bareArea, 'documents');
      expect(target).toEqual({ rowId: 'lane:documents' });
    });

    it('maps commits count to repo with commits when first repo has zero commits', () => {
      const multiRepoArea: BoardArea = {
        ...bareArea,
        repos: [
          { repo: { repo: 'frontend', count: 0, more: 0, commits: [] }, commits: [], commitNodeIds: [], laneId: 'lane:commits:frontend' },
          { repo: { repo: 'backend', count: 2, more: 0, commits: [] }, commits: [{ sha: 'c1', author: 'Dev', subject: 'feat', at: '' }, { sha: 'c2', author: 'Dev', subject: 'fix', at: '' }], commitNodeIds: ['c1', 'c2'], laneId: 'lane:commits:backend' },
        ],
      };
      const target = resolveCountTarget(multiRepoArea, 'commits');
      expect(target).toEqual({ rowId: 'lane:commits:backend' });
    });

    it('maps commits count to fallback lane:commits if no repo laneId', () => {
      const target = resolveCountTarget({ ...bareArea, repos: [] }, 'commits');
      expect(target).toEqual({ rowId: 'lane:commits' });
    });

    it('maps updates count to row:waiting when freshDecisionKey is set', () => {
      const areaWithFreshDecision: BoardArea = {
        ...bareArea,
        data: { ...bareData, freshDecisionKey: 'dec-tz' },
      };
      const target = resolveCountTarget(areaWithFreshDecision, 'updates');
      expect(target).toEqual({ rowId: 'row:waiting' });
    });

    it('maps updates count to changed step row when freshStepKey is set', () => {
      const areaWithFreshStep: BoardArea = {
        ...bareArea,
        data: { ...bareData, freshStepKey: 's2' },
      };
      const target = resolveCountTarget(areaWithFreshStep, 'updates');
      expect(target).toEqual({ rowId: 'row:step:s2', stepKey: 's2' });
    });

    it('maps updates count to checkpoint focus or open step when freshCheckpointKey is set', () => {
      const areaWithFreshCheckpoint: BoardArea = {
        ...bareArea,
        planItems: {
          steps: [
            { key: 'cp-step-1', text: 'Step 1', done: true },
            { key: 'cp-step-2', text: 'Step 2', done: false },
          ],
          decisions: [],
        },
        data: { ...bareData, freshCheckpointKey: 'cp1' },
      };
      const target = resolveCountTarget(areaWithFreshCheckpoint, 'updates');
      expect(target).toEqual({ rowId: 'row:step:cp-step-2', stepKey: 'cp-step-2' });
    });

    it('maps updates count to focusStep when freshStepKey is absent', () => {
      const areaWithFocusStep: BoardArea = {
        ...bareArea,
        data: { ...bareData, focusStep: 's1' },
      };
      const target = resolveCountTarget(areaWithFocusStep, 'updates');
      expect(target).toEqual({ rowId: 'row:step:s1', stepKey: 's1' });
    });

    it('maps updates count to first open step in planItems as fallback', () => {
      const areaWithPlanItemsOnly: BoardArea = {
        ...bareArea,
        steps: undefined,
        planItems: {
          steps: [
            { key: 'p1', text: 'Step P1', done: true },
            { key: 'p2', text: 'Step P2', done: false },
          ],
          decisions: [],
        },
      };
      const target = resolveCountTarget(areaWithPlanItemsOnly, 'updates');
      expect(target).toEqual({ rowId: 'row:step:p2', stepKey: 'p2' });
    });
  });

  describe('cardFooterHeight', () => {
    it('returns 0 when no counts and no warning', () => {
      expect(cardFooterHeight(bareData)).toBe(0);
    });

    it('returns single line height (43px) for one or two short counts', () => {
      const data: AreaData = { ...bareData, noteCount: 2 };
      expect(cardFooterHeight(data)).toBe(43);
    });

    it('returns wrapped height (69px or more) when multiple counts exceed card width', () => {
      const data: AreaData = {
        ...bareData,
        noteCount: 2,
        pictureCount: 38,
        fileCount: 41,
        documentCount: 3,
        commitCount: 5,
        updateCount: 1,
      };
      const height = cardFooterHeight(data, 320);
      expect(height).toBeGreaterThanOrEqual(69);
    });
  });

  describe('areaPlace with 38 pictures and 3 files', () => {
    it('finds the correct page for file card', async () => {
      const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
      const mediaCards: BoardCard[] = Array.from({ length: 38 }, (_, i) => ({
        id: `card-pic-${i}`,
        kind: 'file' as const,
        title: `Picture ${i}`,
        path: `board-pictures/pic-${i}.png`,
        description: `Visual snapshot description for picture ${i}`,
        pinned: false,
        archived: false,
        by: 'claude',
        at: minutesAgo(15 + i),
        updatedBy: 'claude',
        updatedAt: minutesAgo(15 + i),
      }));
      const fileCards: BoardCard[] = [
        {
          id: 'card-file-1',
          kind: 'file' as const,
          title: 'Sample CSV 1',
          path: 'files/export-1.csv',
          description: 'The file 1.',
          pinned: false,
          archived: false,
          by: 'claude',
          at: minutesAgo(80),
          updatedBy: 'claude',
          updatedAt: minutesAgo(80),
        },
        {
          id: 'card-file-2',
          kind: 'file' as const,
          title: 'Sample CSV 2',
          path: 'files/export-2.csv',
          description: 'The file 2.',
          pinned: false,
          archived: false,
          by: 'claude',
          at: minutesAgo(81),
          updatedBy: 'claude',
          updatedAt: minutesAgo(81),
        },
        {
          id: 'card-file-3',
          kind: 'file' as const,
          title: 'Sample CSV 3',
          path: 'files/export-3.csv',
          description: 'The file 3.',
          pinned: false,
          archived: false,
          by: 'claude',
          at: minutesAgo(82),
          updatedBy: 'claude',
          updatedAt: minutesAgo(82),
        },
      ];
      const noteCards: BoardCard[] = [
        {
          id: 'card-note-1',
          kind: 'note' as const,
          title: 'Note 1',
          body: 'Note body',
          pinned: false,
          archived: false,
          by: 'claude',
          at: minutesAgo(10),
          updatedBy: 'claude',
          updatedAt: minutesAgo(10),
        },
        {
          id: 'card-note-2',
          kind: 'note' as const,
          title: 'Note 2',
          body: 'Note body 2',
          pinned: false,
          archived: false,
          by: 'claude',
          at: minutesAgo(12),
          updatedBy: 'claude',
          updatedAt: minutesAgo(12),
        },
      ];
      const area: BoardArea = {
        ...bareArea,
        planItems: {
          steps: [
            { key: 'write-the-csv-writer', text: 'Write the CSV writer', done: false },
            { key: 'background-job-queue-for-large-exports', text: 'Background job queue for large exports', done: false },
            { key: 'download-link-in-the-report-page', text: 'Download link in the report page', done: false },
          ],
          decisions: [
            { key: 'which-time-zone', question: 'Which time zone should export timestamps use?', done: false, suggested: [] },
          ],
          waitingKeys: ['which-time-zone'],
        },
        repos: [
          {
            laneId: 'lane:commits:NexusFlow',
            repo: { repo: 'NexusFlow', commits: [], count: 3, more: 0 },
            commits: [
              { sha: 'a11111111111', author: 'Dev', subject: 'feat: add CSV writer', at: minutesAgo(10) },
            ],
            commitNodeIds: ['commit-1'],
            cards: [],
          },
        ],
        documents: [
          { id: 'doc-csv-spec', title: 'CSV Format Specification', role: 'requirements', status: 'approved' },
        ],
        cards: [...noteCards, ...fileCards, ...mediaCards],
      };
      const target = resolveCountTarget(area, 'files');
      expect(target.cardId).toBe('card-file-1');
      const place = areaPlace(area, { size: { width: 520, height: 750 } }, target.cardId!);
      expect(place?.row).toBe('lane:board');
      expect(place?.tab).toBe('media');
      expect(typeof place?.page).toBe('number');
    });
  });
});
