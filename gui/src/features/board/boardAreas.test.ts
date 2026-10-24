import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import {
  AREA_SIZE,
  areaBoardLayout,
  buildBoardAreas,
  chooseGridColumns,
  fitBoundsView,
  overviewEdges,
  overviewLayout,
} from './boardAreas.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';
import { BOARD_SIZE } from './boardLayout.js';

describe('boardAreas', () => {
  const samplePlan: PlanFileView = {
    title: 'Reports feature',
    checkpoints: [
      {
        key: 'perf',
        title: 'Report rows load fast',
        done: true,
        steps: [{ key: 'p1', text: 'Query rows fast', done: true }],
        decisions: [],
      },
      {
        key: 'csv',
        title: 'Reports export to CSV',
        done: false,
        steps: [
          { key: 'c1', text: 'Write CSV writer', done: true },
          { key: 'c2', text: 'Job queue', done: false },
        ],
        decisions: [{ key: 'd1', question: 'Which time zone?' }],
      },
      {
        key: 'ship',
        title: 'Ship it',
        done: false,
        steps: [{ key: 's1', text: 'Deploy to prod', done: false }],
        decisions: [],
      },
    ],
    steps: [{ key: 'loose1', text: 'Loose step', done: false }],
    decisions: [{ key: 'loose_d1', question: 'Global question?' }],
    waiting: ['d1', 'loose_d1'],
  };

  const sampleDoc = (id: string, title: string, milestoneId?: string): WorkDocument => ({
    id,
    title,
    role: 'requirements',
    status: 'approved',
    scope: milestoneId ? { milestoneId } : {},
    summary: `Summary of ${title}`,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  });

  const sampleCard = (id: string, title: string, area?: string, extra?: Partial<BoardCard>): BoardCard => ({
    id,
    kind: 'note',
    title,
    body: `Body for ${title}`,
    pinned: false,
    archived: false,
    by: 'user',
    at: '2026-10-01T00:00:00Z',
    updatedBy: 'user',
    updatedAt: '2026-10-01T00:00:00Z',
    area,
    ...extra,
  });

  describe('buildBoardAreas', () => {
    it('returns empty array when workspace has 0 items and no plan', () => {
      const areas = buildBoardAreas({});
      expect(areas).toEqual([]);
    });

    it('creates fallback area:work ("Current work") when workspace has content but 0 plan checkpoints', () => {
      const board: BoardView = {
        cards: [sampleCard('c1', 'Card without plan')],
        positions: {},
        links: [],
      };
      const areas = buildBoardAreas({ board });
      expect(areas).toHaveLength(1);
      expect(areas[0]!.id).toBe('area:work');
      expect(areas[0]!.data.title).toBe('Current work');
      expect(areas[0]!.data.kind).toBe('work');
      expect(areas[0]!.data.current).toBe(true);
      expect(areas[0]!.cards).toHaveLength(1);
    });

    it('creates plan:own area when loose steps or waiting decisions exist', () => {
      const areas = buildBoardAreas({ plan: samplePlan });
      expect(areas.map((a) => a.id)).toEqual([
        'plan:own',
        'checkpoint:perf',
        'checkpoint:csv',
        'checkpoint:ship',
      ]);
      expect(areas[0]!.data.title).toBe('Plan');
      expect(areas[0]!.data.kind).toBe('plan');
      expect(areas[0]!.data.stepsTotal).toBe(1);
      expect(areas[0]!.data.waitingCount).toBe(1);
    });

    it('selects first undone checkpoint as current area', () => {
      const areas = buildBoardAreas({ plan: samplePlan });
      const current = areas.find((a) => a.data.current);
      expect(current?.id).toBe('checkpoint:csv');
    });

    it('selects last checkpoint as current when all checkpoints are done', () => {
      const allDonePlan: PlanFileView = {
        title: 'All done',
        checkpoints: [
          { key: 'cp1', title: 'CP1', done: true, steps: [], decisions: [] },
          { key: 'cp2', title: 'CP2', done: true, steps: [], decisions: [] },
        ],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const areas = buildBoardAreas({ plan: allDonePlan });
      expect(areas.find((a) => a.data.current)?.id).toBe('checkpoint:cp2');
    });

    it('routes cards via card.area, fallback via board.links, and fallback to current', () => {
      const cardA = sampleCard('card-a', 'Assigned to perf', 'checkpoint:perf');
      const cardB = sampleCard('card-b', 'Linked to ship');
      const cardC = sampleCard('card-c', 'Default to current');
      const cardRenamed = sampleCard('card-renamed', 'Renamed area target', 'checkpoint:old-renamed');

      const links: BoardLink[] = [{ id: 'link-1', from: 'card-b', to: 'checkpoint:ship' }];
      const board: BoardView = {
        cards: [cardA, cardB, cardC, cardRenamed],
        positions: {},
        links,
      };

      const areas = buildBoardAreas({ plan: samplePlan, board });
      const perf = areas.find((a) => a.id === 'checkpoint:perf')!;
      const csv = areas.find((a) => a.id === 'checkpoint:csv')!;
      const ship = areas.find((a) => a.id === 'checkpoint:ship')!;

      expect(perf.cards.map((c) => c.id)).toContain('card-a');
      expect(ship.cards.map((c) => c.id)).toContain('card-b');
      expect(csv.cards.map((c) => c.id)).toContain('card-c');
      expect(csv.cards.map((c) => c.id)).toContain('card-renamed');
    });

    it('tracks archived cards in archivedCount and hides them from visible cards unless showArchived is true', () => {
      const activeCard = sampleCard('active-1', 'Active note');
      const archivedCard = sampleCard('arch-1', 'Archived note', undefined, { archived: true });
      const board: BoardView = {
        cards: [activeCard, archivedCard],
        positions: {},
        links: [],
      };

      const hidden = buildBoardAreas({ plan: samplePlan, board, showArchived: false });
      const csvHidden = hidden.find((a) => a.id === 'checkpoint:csv')!;
      expect(csvHidden.archivedCount).toBe(1);
      expect(csvHidden.cards).toHaveLength(1);
      expect(csvHidden.cards[0]!.id).toBe('active-1');
      expect(csvHidden.data.noteCount).toBe(1);

      const shown = buildBoardAreas({ plan: samplePlan, board, showArchived: true });
      const csvShown = shown.find((a) => a.id === 'checkpoint:csv')!;
      expect(csvShown.archivedCount).toBe(1);
      expect(csvShown.cards).toHaveLength(2);
      expect(csvShown.data.noteCount).toBe(2);
    });

    it('routes documents by milestoneId, links, or current area', () => {
      const doc1 = sampleDoc('doc-1', 'Perf doc', 'perf');
      const doc2 = sampleDoc('doc-2', 'Ship doc');
      const doc3 = sampleDoc('doc-3', 'Unassigned doc');

      const links: BoardLink[] = [{ id: 'link-d', from: 'document:doc-2', to: 'checkpoint:ship' }];
      const areas = buildBoardAreas({
        plan: samplePlan,
        documents: [doc1, doc2, doc3],
        board: { cards: [], positions: {}, links },
      });

      const perf = areas.find((a) => a.id === 'checkpoint:perf')!;
      const ship = areas.find((a) => a.id === 'checkpoint:ship')!;
      const csv = areas.find((a) => a.id === 'checkpoint:csv')!;

      expect(perf.documents.map((d) => d.id)).toContain('doc-1');
      expect(ship.documents.map((d) => d.id)).toContain('doc-2');
      expect(csv.documents.map((d) => d.id)).toContain('doc-3');
    });

    it('routes commits by 7-char short SHA links or current area, and attaches repo problems', () => {
      const news: WhatsNewView = {
        basis: 'first-look',
        from: '2026-10-01T00:00:00Z',
        at: '2026-10-02T00:00:00Z',
        commits: [
          {
            repo: 'billing',
            more: 0,
            commits: [
              { sha: 'abcdef1234567890', subject: 'Billing commit for ship', author: 'Anna', at: '2026-10-01T12:00:00Z' },
              { sha: '1122334455667788', subject: 'General commit', author: 'Bob', at: '2026-10-01T11:00:00Z' },
            ],
          },
          {
            repo: 'auth',
            more: 0,
            commits: [],
            problem: 'Repository locked',
          },
        ],
      };

      const links: BoardLink[] = [
        { id: 'l1', from: 'commit:billing:abcdef1', to: 'checkpoint:ship' },
      ];

      const areas = buildBoardAreas({ plan: samplePlan, news, board: { cards: [], positions: {}, links } });
      const ship = areas.find((a) => a.id === 'checkpoint:ship')!;
      const csv = areas.find((a) => a.id === 'checkpoint:csv')!;

      expect(ship.data.commitCount).toBe(1);
      expect(csv.data.commitCount).toBe(1);
      // auth problem attached to current area (csv)
      expect(csv.data.warning).toBe('Could not read everything');
      expect(csv.repos.some((r) => r.repo.repo === 'auth')).toBe(true);
    });

    it('extracts up to 3 image picture previews and formats fallback text preview', () => {
      const picCard1 = sampleCard('pic1', 'Mockup 1', 'checkpoint:perf', {
        kind: 'file',
        path: 'assets/screen1.png',
        description: 'First screen',
      });
      const picCard2 = sampleCard('pic2', 'Mockup 2', 'checkpoint:perf', {
        kind: 'file',
        path: 'assets/screen2.jpg',
        description: 'Second screen',
      });
      const board: BoardView = {
        cards: [picCard1, picCard2],
        positions: {},
        links: [],
      };

      const areas = buildBoardAreas({ plan: samplePlan, board });
      const perf = areas.find((a) => a.id === 'checkpoint:perf')!;
      expect(perf.data.pictureCount).toBe(2);
      expect(perf.data.pictures).toHaveLength(2);
      expect(perf.data.pictures[0]!.path).toBe('assets/screen1.png');

      const csv = areas.find((a) => a.id === 'checkpoint:csv')!;
      // csv has no pictures, has waiting decision: fallback preview should be the waiting question
      expect(csv.data.pictures).toHaveLength(0);
      expect(csv.data.preview).toBe('Which time zone?');
    });

    it('detects fresh AI cards made in the last minute', () => {
      const now = Date.parse('2026-10-24T12:00:00Z');
      const freshCard = sampleCard('fresh-1', 'AI Note', 'checkpoint:ship', {
        by: 'claude',
        updatedBy: 'claude',
        at: new Date(now - 15_000).toISOString(),
        updatedAt: new Date(now - 15_000).toISOString(),
      });
      const areas = buildBoardAreas({
        plan: samplePlan,
        board: { cards: [freshCard], positions: {}, links: [] },
        now,
      });
      const ship = areas.find((a) => a.id === 'checkpoint:ship')!;
      expect(ship.data.fresh).toBe(true);
      expect(ship.data.freshKey).toBe(freshCard.updatedAt);
    });
  });

  describe('chooseGridColumns, overviewLayout & fitBoundsView', () => {
    it('chooses appropriate columns across 1, 3, 8, and 12 areas', () => {
      const size1440 = { width: 1440, height: 900 };
      expect(chooseGridColumns(1, size1440)).toBe(1);
      expect(chooseGridColumns(3, size1440)).toBe(3);
      expect(chooseGridColumns(8, size1440)).toBeGreaterThanOrEqual(3);
      expect(chooseGridColumns(12, size1440)).toBeGreaterThanOrEqual(3);

      const sizeNarrow = { width: 820, height: 900 };
      expect(chooseGridColumns(3, sizeNarrow)).toBeLessThanOrEqual(2);
    });

    it('proves 1, 3, 8, and 12 areas fit whole inside 1440x900 and 820x900 without overflow', () => {
      const viewports = [
        { width: 1440, height: 900 },
        { width: 820, height: 900 },
      ];
      const counts = [1, 3, 8, 12];

      for (const vp of viewports) {
        for (const count of counts) {
          const areas = Array.from({ length: count }, (_, i) => ({
            id: `area-${i}`,
            kind: 'checkpoint' as const,
            data: {
              kind: 'checkpoint' as const,
              title: `Area ${i}`,
              done: false,
              current: i === 0,
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
            },
            documents: [],
            repos: [],
            cards: [],
            archivedCount: 0,
            allMemberNodeIds: [`area-${i}`],
          }));

          const nodes = overviewLayout(areas, vp);
          expect(nodes).toHaveLength(count);

          const fit = fitBoundsView(nodes, vp);
          expect(fit).not.toBeNull();
          expect(fit!.zoom).toBeLessThanOrEqual(1);

          for (const node of nodes) {
            const screenLeft = node.position.x * fit!.zoom + fit!.x;
            const screenRight = (node.position.x + (node.width ?? AREA_SIZE.width)) * fit!.zoom + fit!.x;
            const screenTop = node.position.y * fit!.zoom + fit!.y;
            const screenBottom = (node.position.y + (node.height ?? AREA_SIZE.height)) * fit!.zoom + fit!.y;

            expect(screenLeft).toBeGreaterThanOrEqual(-0.01);
            expect(screenRight).toBeLessThanOrEqual(vp.width + 0.01);
            expect(screenTop).toBeGreaterThanOrEqual(-0.01);
            expect(screenBottom).toBeLessThanOrEqual(vp.height + 0.01);
          }
        }
      }
    });
  });

  describe('overviewEdges', () => {
    it('deduplicates multiple links between the same two areas and ignores intra-area links', () => {
      const areas = buildBoardAreas({ plan: samplePlan });
      const nodes = overviewLayout(areas, { width: 1440, height: 900 });

      const links: BoardLink[] = [
        // 2 links from perf to csv
        { id: 'l1', from: 'checkpoint:perf', to: 'checkpoint:csv', label: 'depends on' },
        { id: 'l2', from: 'checkpoint:perf', to: 'checkpoint:csv' },
        // intra-area link inside csv
        { id: 'l3', from: 'checkpoint:csv', to: 'checkpoint:csv' },
      ];

      const edges = overviewEdges(areas, nodes, links);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.id).toBe('l1');
      expect(edges[0]!.source).toBe('checkpoint:perf');
      expect(edges[0]!.target).toBe('checkpoint:csv');
      expect(edges[0]!.label).toBe('2 links');
      expect(edges[0]!.ariaLabel).toContain('2 links');
    });
  });

  describe('areaBoardLayout', () => {
    it('produces deterministic coordinates with collapsible: false and fits within screen', () => {
      const areas = buildBoardAreas({
        plan: samplePlan,
        documents: [sampleDoc('d1', 'Doc 1', 'csv')],
        board: {
          cards: [sampleCard('c1', 'Card 1', 'checkpoint:csv')],
          positions: {},
          links: [],
        },
      });

      const csvArea = areas.find((a) => a.id === 'checkpoint:csv')!;
      const nodes1 = areaBoardLayout(csvArea);
      const nodes2 = areaBoardLayout(csvArea);

      expect(nodes1).toEqual(nodes2);

      const frameNode = nodes1.find((n) => n.id === 'checkpoint:csv');
      expect(frameNode).toBeDefined();
      expect(frameNode?.type).toBe('checkpoint');
      expect((frameNode as any).data.collapsible).toBe(false);

      const fit = fitBoundsView(nodes1, { width: 1440, height: 900 });
      expect(fit).not.toBeNull();
      expect(fit!.zoom).toBeLessThanOrEqual(1);

      for (const node of nodes1.filter((n) => !n.parentId)) {
        const screenLeft = node.position.x * fit!.zoom + fit!.x;
        const screenRight = (node.position.x + (node.width ?? BOARD_SIZE.card)) * fit!.zoom + fit!.x;
        const screenTop = node.position.y * fit!.zoom + fit!.y;
        const screenBottom = (node.position.y + (node.height ?? 0)) * fit!.zoom + fit!.y;

        expect(screenLeft).toBeGreaterThanOrEqual(-0.01);
        expect(screenRight).toBeLessThanOrEqual(1440 + 0.01);
        expect(screenTop).toBeGreaterThanOrEqual(-0.01);
        expect(screenBottom).toBeLessThanOrEqual(900 + 0.01);
      }
    });

    it('accurately sets waitingKeys when decision 0 is answered and decision 1 is waiting', () => {
      const plan: PlanFileView = {
        title: 'Mixed decisions plan',
        checkpoints: [
          {
            key: 'cp1',
            title: 'Checkpoint 1',
            done: false,
            steps: [{ key: 's1', text: 'Step 1', done: false }],
            decisions: [
              { key: 'd0', question: 'Answered question?', answer: 'Yes' },
              { key: 'd1', question: 'Waiting question?' },
            ],
          },
        ],
        steps: [],
        decisions: [],
        waiting: ['d1'],
      };
      const areas = buildBoardAreas({ plan });
      const cpArea = areas.find((a) => a.id === 'checkpoint:cp1')!;
      expect(cpArea).toBeDefined();
      expect(cpArea.data.waitingCount).toBe(1);
      expect(cpArea.planItems?.waitingKeys).toEqual(['d1']);

      const nodes = areaBoardLayout(cpArea);
      const frameNode = nodes.find((n) => n.id === 'checkpoint:cp1');
      expect(frameNode).toBeDefined();
      expect(frameNode?.data.waiting).toHaveLength(1);
      expect(frameNode?.data.waiting[0]?.key).toBe('d1');
      expect(frameNode?.data.waiting[0]?.question).toBe('Waiting question?');
    });

    it('routes items transitively via item-to-item links and resolves short commit SHAs', () => {
      const plan: PlanFileView = {
        title: 'Link routing plan',
        checkpoints: [
          { key: 'perf', title: 'Perf checkpoint', done: true, steps: [], decisions: [] },
          { key: 'current', title: 'Current checkpoint', done: false, steps: [], decisions: [] },
        ],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const board: BoardView = {
        cards: [
          sampleCard('card-A', 'Card A', 'checkpoint:perf'),
          sampleCard('card-B', 'Card B'),
        ],
        positions: {},
        links: [
          { id: 'l1', from: 'card-B', to: 'card-A' },
          { id: 'l2', from: 'commit:api:a91f2e0', to: 'card-A' },
        ],
      };
      const news: WhatsNewView = {
        basis: 'stream',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T11:00:00Z',
        commits: [
          {
            repo: 'api',
            more: 0,
            commits: [
              { sha: 'a91f2e0c4d5b6e7f', subject: 'Optimize queries', author: 'Anna', at: '2026-10-24T11:30:00Z' },
            ],
          },
        ],
      };

      const areas = buildBoardAreas({ plan, board, news });
      const perfArea = areas.find((a) => a.id === 'checkpoint:perf')!;
      const currentArea = areas.find((a) => a.id === 'checkpoint:current')!;

      expect(perfArea.cards.map((c) => c.id)).toContain('card-A');
      expect(perfArea.cards.map((c) => c.id)).toContain('card-B');
      expect(currentArea.cards).toHaveLength(0);

      expect(perfArea.data.commitCount).toBe(1);
      expect(perfArea.repos).toHaveLength(1);
      expect(perfArea.repos[0]!.commits[0]!.sha).toBe('a91f2e0c4d5b6e7f');
      expect(currentArea.data.commitCount).toBe(0);
    });

    it('handles split-repo commits without phantom more counts and prevents duplicate problem lanes', () => {
      const plan: PlanFileView = {
        title: 'Split commits plan',
        checkpoints: [
          { key: 'cp1', title: 'Checkpoint 1', done: true, steps: [], decisions: [] },
          { key: 'cp2', title: 'Checkpoint 2 (current)', done: false, steps: [], decisions: [] },
        ],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const board: BoardView = {
        cards: [
          sampleCard('c-cp1', 'Card 1', 'checkpoint:cp1'),
        ],
        positions: {},
        links: [
          { id: 'l1', from: 'commit:billing api:1111111', to: 'checkpoint:cp1' },
          { id: 'l2', from: 'commit:broken:3333333', to: 'checkpoint:cp1' },
        ],
      };
      const news: WhatsNewView = {
        basis: 'stream',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T11:00:00Z',
        commits: [
          {
            repo: 'billing api',
            more: 0,
            commits: [
              { sha: '1111111aaaaaaaaa', subject: 'Billing 1', author: 'Bob', at: '2026-10-24T11:30:00Z' },
              { sha: '2222222bbbbbbbbb', subject: 'Billing 2', author: 'Bob', at: '2026-10-24T11:35:00Z' },
            ],
          },
          {
            repo: 'broken',
            more: 0,
            problem: 'The folder is missing.',
            commits: [
              { sha: '3333333ccccccccc', subject: 'Broken 1', author: 'Bob', at: '2026-10-24T11:20:00Z' },
            ],
          },
        ],
      };

      const areas = buildBoardAreas({ plan, board, news });
      const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
      const cp2 = areas.find((a) => a.id === 'checkpoint:cp2')!;

      const billing1 = cp1.repos.find((r) => r.repo.repo === 'billing api')!;
      const billing2 = cp2.repos.find((r) => r.repo.repo === 'billing api')!;
      expect(billing1).toBeDefined();
      expect(billing2).toBeDefined();
      expect(billing1.laneId).toBe('lane:commits:billing api');
      expect(billing2.laneId).toBe('lane:commits:billing api');

      expect(billing1.repo.more).toBe(0);
      expect(billing2.repo.more).toBe(0);

      const broken1 = cp1.repos.find((r) => r.repo.repo === 'broken');
      const broken2 = cp2.repos.find((r) => r.repo.repo === 'broken');
      expect(broken1).toBeDefined();
      expect(broken1?.commits).toHaveLength(1);
      expect(broken2).toBeUndefined();
    });

    it('does not create phantom repo lanes for clean 0-commit repos and draws only the placeholder lane', () => {
      const plan: PlanFileView = {
        title: 'Plan with current checkpoint',
        checkpoints: [
          { key: 'cp1', title: 'Work in progress', done: false, steps: [{ key: 's1', text: 'Step 1', done: false }], decisions: [] },
        ],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const news: WhatsNewView = {
        basis: 'stream',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T11:00:00Z',
        commits: [
          { repo: 'api', more: 0, commits: [] },
        ],
      };

      const areas = buildBoardAreas({ plan, news });
      const currentArea = areas.find((a) => a.id === 'checkpoint:cp1')!;
      expect(currentArea).toBeDefined();
      expect(currentArea.repos).toHaveLength(0);

      const nodes = areaBoardLayout(currentArea, { news });
      const laneNodes = nodes.filter((n) => n.id.startsWith('lane:commits'));
      expect(laneNodes).toHaveLength(1);
      expect(laneNodes[0]!.id).toBe('lane:commits');
      expect(laneNodes[0]!.data.title).toBe('Commits');
      expect(nodes.some((n) => n.id.includes('lane:commits:api'))).toBe(false);
    });

    it('picks newest commit across repositories for preview and computes preview even when pictures are present', () => {
      const plan: PlanFileView = {
        title: 'Multi repo plan',
        checkpoints: [
          { key: 'cp1', title: 'Feature CP', done: false, steps: [], decisions: [] },
        ],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const board: BoardView = {
        cards: [
          sampleCard('pic1', 'Design mockup', 'checkpoint:cp1', { kind: 'file', path: 'mockup.png', description: 'Design mockup' }),
        ],
        positions: {},
        links: [
          { id: 'l1', from: 'commit:repoA:1111111', to: 'checkpoint:cp1' },
          { id: 'l2', from: 'commit:repoB:2222222', to: 'checkpoint:cp1' },
        ],
      };
      const news: WhatsNewView = {
        basis: 'stream',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T11:00:00Z',
        commits: [
          {
            repo: 'repoA',
            more: 0,
            commits: [
              { sha: '1111111aaaaa', subject: 'Older commit in repoA', author: 'Alice', at: '2026-10-24T11:10:00Z' },
            ],
          },
          {
            repo: 'repoB',
            more: 0,
            commits: [
              { sha: '2222222bbbbb', subject: 'Newer commit in repoB', author: 'Bob', at: '2026-10-24T11:40:00Z' },
            ],
          },
        ],
      };

      const areas = buildBoardAreas({ plan, board, news });
      const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
      expect(cp1.data.pictures).toHaveLength(1);
      // Unconditionally computed preview matches the newest commit across repos even though repoB is second in news
      expect(cp1.data.preview).toBe('Newer commit in repoB');
    });
  });
});
