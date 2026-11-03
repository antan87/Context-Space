import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import {
  AREA_ROW,
  AREA_SIZE,
  OVERVIEW_FOLD,
  OVERVIEW_INSET,
  areaBoardLayout,
  areaCardHeight,
  areaCounts,
  buildBoardAreas,
  extractFreshSets,
  overviewEdges,
  overviewLayout,
  overviewPlan,
  type AreaData,
  type BoardArea,
  type OverviewNode,
} from './boardAreas.js';
import { READABLE_ZOOM } from './boardRows.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';

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

  /** Areas as the overview draws them: `done` of the first ones are finished and the next one is under way. */
  const manyAreas = (count: number, options: { done?: number; data?: Partial<AreaData> } = {}): BoardArea[] => Array.from({ length: count }, (_, i) => {
    const done = i < (options.done ?? 0);
    const data: AreaData = {
      kind: 'checkpoint', title: `Checkpoint ${i + 1}: the work of one slice`, done, current: i === (options.done ?? 0), stepsDone: done ? 3 : 1, stepsTotal: 3,
      waitingCount: 0, noteCount: 0, fileCount: 0, pictureCount: 0, documentCount: 0, commitCount: 0, archivedCount: 0, pictures: [], fresh: false, ...options.data,
    };
    return { id: `area-${i}`, kind: 'checkpoint', data, documents: [], repos: [], cards: [], archivedCount: 0, allMemberNodeIds: [`area-${i}`] };
  });
  /** An Area as it is in a workspace that is being worked on: a preview line and counts. */
  const realistic: Partial<AreaData> = { preview: 'Which time zone should export timestamps use?', noteCount: 2, commitCount: 3 };

  const sizes = { laptop: { width: 1280, height: 700 }, pane: { width: 400, height: 700 }, phone: { width: 390, height: 650 } };

  describe('overviewPlan', () => {
    it('draws cards where they fit at a readable size, and one-line rows where they do not', () => {
      expect(overviewPlan(manyAreas(1), sizes.laptop).form).toBe('cards');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.laptop).form).toBe('cards');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.pane).form).toBe('cards');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.phone).form).toBe('cards');
      // Eleven realistic cards fit the laptop in four columns, but not the pane or the phone at 0.9
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.laptop).form).toBe('cards');
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.pane).form).toBe('rows');
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.phone).form).toBe('rows');
      expect(overviewPlan(manyAreas(25, { data: realistic }), sizes.laptop).form).toBe('rows');
      expect(overviewPlan(manyAreas(25), sizes.pane).form).toBe('rows');
      expect(overviewPlan(manyAreas(25), sizes.phone).form).toBe('rows');
    });

    it('never draws cards below the readable zoom, nor above life size, and keeps every card whole in the stage', () => {
      for (const size of [...Object.values(sizes), { width: 820, height: 900 }, { width: 1440, height: 900 }, { width: 640, height: 500 }]) {
        for (const count of [1, 2, 3, 5, 8, 11, 12, 25]) {
          for (const data of [{}, realistic]) {
            const plan = overviewPlan(manyAreas(count, { data }), size);
            if (plan.form !== 'cards') continue;
            const { x, y, zoom } = plan.viewport!;
            expect(zoom).toBeGreaterThanOrEqual(READABLE_ZOOM - 1e-9);
            expect(zoom).toBeLessThanOrEqual(1);
            expect(plan.nodes).toHaveLength(count);
            for (const node of plan.nodes) {
              expect(node.position.x * zoom + x).toBeGreaterThanOrEqual(OVERVIEW_INSET.side - 0.01);
              expect((node.position.x + node.width!) * zoom + x).toBeLessThanOrEqual(size.width - OVERVIEW_INSET.side + 0.01);
              expect(node.position.y * zoom + y).toBeGreaterThanOrEqual(OVERVIEW_INSET.top - 0.01);
              expect((node.position.y + node.height!) * zoom + y).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom + 0.01);
            }
          }
        }
      }
    });

    it('stands a few cards in one line at life size, and uses the columns the width allows', () => {
      const three = overviewPlan(manyAreas(3, { data: realistic }), sizes.laptop);
      expect(three.nodes.map((node) => node.position.y)).toEqual([0, 0, 0]);
      expect(three.viewport!.zoom).toBe(1);
      const wide = overviewPlan(manyAreas(8, { data: realistic }), { width: 1440, height: 900 });
      expect(wide.form).toBe('cards');
      expect(new Set(wide.nodes.map((node) => node.position.x)).size).toBeGreaterThanOrEqual(3);
    });

    it('draws rows in the order of the Areas, one column in a narrow stage, with all of them in view and none above the other\'s place', () => {
      for (const size of [sizes.pane, sizes.phone]) {
        const plan = overviewPlan(manyAreas(11, { done: 4, data: realistic }), size);
        expect(plan.form).toBe('rows');
        expect(plan.nodes.map((node) => node.id)).toEqual(manyAreas(11).map((area) => area.id));
        expect(plan.nodes.every((node) => node.type === 'areaRow' && node.height === AREA_ROW.height)).toBe(true);
        expect(new Set(plan.nodes.map((node) => node.position.x)).size).toBe(1);
        expect(plan.viewport!.zoom).toBe(1);
        const ys = plan.nodes.map((node) => node.position.y);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
        const last = plan.nodes.at(-1)!;
        expect(last.position.y + last.height! + plan.viewport!.y).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom);
        expect(plan.viewport!.x + last.width!).toBeLessThanOrEqual(size.width);
      }
    });

    it('puts the rows of a wide stage in more columns when one column would not hold them', () => {
      const plan = overviewPlan(manyAreas(25), sizes.laptop);
      expect(plan.form).toBe('rows');
      const columns = new Set(plan.nodes.map((node) => node.position.x));
      expect(columns.size).toBe(2);
      expect(plan.nodes).toHaveLength(25);
      expect(plan.nodes.some((node) => node.type === 'areaFold')).toBe(false);
    });

    it('folds the finished Areas into one last row when the rows do not fit, and opens them on request', () => {
      const areas = manyAreas(25, { done: 15 });
      const plan = overviewPlan(areas, sizes.phone);
      expect(plan.form).toBe('rows');
      const fold = plan.nodes.at(-1) as OverviewNode;
      expect(fold.type).toBe('areaFold');
      expect(fold.id).toBe(OVERVIEW_FOLD);
      expect(fold.data).toEqual({ count: 15, kind: 'done', expanded: false });
      // What is left is in order, the Area under way among it, and it all fits
      expect(plan.nodes.slice(0, -1).map((node) => node.id)).toEqual(areas.slice(15).map((area) => area.id));
      expect(plan.nodes.slice(0, -1).some((node) => node.type === 'areaRow' && node.data.current)).toBe(true);
      const last = plan.nodes.at(-1)!;
      expect(last.position.y + last.height! + plan.viewport!.y).toBeLessThanOrEqual(sizes.phone.height - OVERVIEW_INSET.bottom);

      const open = overviewPlan(areas, sizes.phone, { expanded: true });
      expect(open.nodes.filter((node) => node.type === 'areaRow')).toHaveLength(25);
      expect(open.nodes.at(-1)!.data).toEqual({ count: 15, kind: 'done', expanded: true });
    });

    it('folds Areas at the end too, never the one under way, when the finished ones are not enough', () => {
      const areas = manyAreas(40, { done: 3 });
      const plan = overviewPlan(areas, sizes.phone);
      const fold = plan.nodes.at(-1)!;
      expect(fold.type).toBe('areaFold');
      expect(fold.data).toMatchObject({ kind: 'more', expanded: false });
      const rows = plan.nodes.slice(0, -1);
      expect(rows.some((node) => node.id === 'area-3')).toBe(true);
      expect(rows.every((node) => !(node.data as AreaData).done)).toBe(true);
      expect(rows.length + (fold.data as { count: number }).count).toBe(40);
      const last = fold;
      expect(last.position.y + last.height! + plan.viewport!.y).toBeLessThanOrEqual(sizes.phone.height - OVERVIEW_INSET.bottom);
    });

    it('never folds the Area under way, even when it is the last of many', () => {
      const areas = manyAreas(40).map((area, i) => ({ ...area, data: { ...area.data, current: i === 39 } }));
      const plan = overviewPlan(areas, sizes.phone);
      const fold = plan.nodes.at(-1)!;
      expect(fold.type).toBe('areaFold');
      const rows = plan.nodes.slice(0, -1);
      expect(rows.at(-1)!.id).toBe('area-39');
      expect(rows.find((node) => node.id === 'area-39')!.data).toMatchObject({ current: true });
      expect(rows.length + (fold.data as { count: number }).count).toBe(40);
      expect(plan.nodes.at(-1)!.position.y + AREA_ROW.height + plan.viewport!.y).toBeLessThanOrEqual(sizes.phone.height - OVERVIEW_INSET.bottom);
    });

    it('does not fold when every row fits, and has no lines between rows', () => {
      const plan = overviewPlan(manyAreas(11, { done: 5 }), sizes.phone);
      expect(plan.nodes.every((node) => node.type === 'areaRow')).toBe(true);
      const areas = manyAreas(11);
      expect(overviewEdges(areas, plan.nodes, [{ id: 'l', from: 'area-0', to: 'area-4' }])).toEqual([]);
    });

    it('guesses cards before the stage is measured, and is empty without Areas', () => {
      expect(overviewPlan([], sizes.laptop)).toEqual({ form: 'cards', nodes: [], viewport: null });
      const unknown = overviewPlan(manyAreas(5), { width: 0, height: 0 });
      expect(unknown.form).toBe('cards');
      expect(unknown.nodes).toHaveLength(5);
      expect(unknown.viewport).toBeNull();
    });

    it('makes a card as high as its content needs and no higher, so a card with nothing attached has no blank space', () => {
      const bare = manyAreas(1)[0]!.data;
      const withPictures = { ...bare, pictures: [{ path: 'a.png', alt: 'A' }], pictureCount: 1, fileCount: 1 };
      expect(areaCardHeight(bare)).toBeLessThan(AREA_SIZE.height + 30);
      expect(areaCardHeight(withPictures)).toBeGreaterThan(areaCardHeight(bare) + 60);
      expect(areaCardHeight({ ...bare, ...realistic })).toBeGreaterThan(areaCardHeight(bare));
      expect(areaCardHeight({ ...bare, title: 'Short', stepsTotal: 0, kind: 'work' })).toBeLessThan(areaCardHeight(bare));
      // The cards of one line stand level, as high as the highest, and a line without pictures is not made higher by another's
      const plan = overviewPlan([{ ...manyAreas(1)[0]!, id: 'pics', data: withPictures }, ...manyAreas(2), ...manyAreas(3).map((area, i) => ({ ...area, id: `later-${i}` }))], { width: 1440, height: 1200 });
      expect(plan.form).toBe('cards');
      const lines = new Map<number, Set<number | undefined>>();
      for (const node of plan.nodes) lines.set(node.position.y, (lines.get(node.position.y) ?? new Set()).add(node.height));
      expect([...lines.values()].every((heights) => heights.size === 1)).toBe(true);
      expect(plan.nodes[0]!.height).toBeGreaterThan(plan.nodes.at(-1)!.height! + 60);
    });

    it('guesses a second line of title from the width of its letters, as the browser draws them', () => {
      const bare = manyAreas(1)[0]!.data;
      const high = (title: string) => areaCardHeight({ ...bare, title });
      // Measured in Inter 14 px semibold in a card 294 px wide: these are 224, 282, 317 and 560 px, and 160 px for 40 narrow letters
      expect(high('Pictures are told apart from files')).toBe(high('Short'));
      expect(high('Documents open in a reader beside the board')).toBeGreaterThan(high('Short'));
      expect(high('W'.repeat(40))).toBeGreaterThan(high('Short'));
      expect(high('i'.repeat(40))).toBe(high('Short'));
    });

    it('says what a card counts, and nothing that is zero', () => {
      const bare = manyAreas(1)[0]!.data;
      expect(areaCounts(bare)).toEqual([]);
      expect(areaCounts({ ...bare, noteCount: 1, pictureCount: 2, fileCount: 3, documentCount: 4, commitCount: 1 })).toEqual(['1 note', '2 pictures', '1 file', '4 documents', '1 commit']);
    });

    it('lays out the nodes of the plan', () => {
      const areas = manyAreas(3, { data: realistic });
      expect(overviewLayout(areas, sizes.laptop)).toEqual(overviewPlan(areas, sizes.laptop).nodes);
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
    it('produces deterministic coordinates and keeps the waiting frame fixed', () => {
      const areas = buildBoardAreas({
        plan: samplePlan,
        documents: [sampleDoc('d1', 'Doc 1', 'csv')],
        board: { cards: [sampleCard('c1', 'Card 1', 'checkpoint:csv')], positions: {}, links: [] },
      });
      const csvArea = areas.find((a) => a.id === 'checkpoint:csv')!;
      const nodes1 = areaBoardLayout(csvArea);
      expect(nodes1).toEqual(areaBoardLayout(csvArea));
      const frameNode = nodes1.find((n) => n.id === 'checkpoint:csv');
      expect(frameNode?.type).toBe('checkpoint');
      expect((frameNode as any).data.collapsible).toBe(false);
      expect((frameNode as any).data.waitingOnly).toBe(true);
      expect(nodes1.every((n) => n.parentId === undefined)).toBe(true);
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

    it('marks Area and commit cards fresh when commits are in news', () => {
      const plan: PlanFileView = {
        title: 'Fresh Test',
        overview: '',
        checkpoints: [{ key: 'cp1', title: 'Checkpoint 1', done: false, steps: [] }],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const news: WhatsNewView = {
        reader: 'user',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T10:00:00Z',
        basis: 'last-look',
        empty: false,
        plan: { items: [], more: 0 },
        documents: { items: [], more: 0 },
        knowledge: { items: [], more: 0 },
        problems: [],
        commits: [
          {
            repo: 'repoA',
            more: 0,
            commits: [
              { sha: 'abcdef1234567890', subject: 'Fresh commit', author: 'Anton', at: '2026-10-24T11:50:00Z' },
            ],
          },
        ],
      };

      const areas = buildBoardAreas({ plan, news });
      const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
      expect(cp1.data.fresh).toBe(true);
      expect(cp1.repos[0]?.cards[0]?.data && (cp1.repos[0].cards[0].data as any).fresh).toBe(true);
    });

    it('marks Area fresh when a document in the area is new in news', () => {
      const plan: PlanFileView = {
        title: 'Doc Fresh Test',
        overview: '',
        checkpoints: [{ key: 'cp1', title: 'Checkpoint 1', done: false, steps: [] }],
        steps: [],
        decisions: [],
        waiting: [],
      };
      const documents: WorkDocument[] = [
        {
          id: 'doc-brief',
          title: 'Project Brief',
          filename: 'brief.md',
          role: 'requirements',
          status: 'approved',
          scope: { milestoneId: 'cp1' },
          createdAt: '2026-10-24T10:00:00Z',
          updatedAt: '2026-10-24T11:45:00Z',
        },
      ];
      const news: WhatsNewView = {
        reader: 'user',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T10:00:00Z',
        basis: 'last-look',
        empty: false,
        plan: { items: [], more: 0 },
        documents: { items: [{ name: 'brief.md', kind: 'markdown', change: 'changed', at: '2026-10-24T11:45:00Z' }], more: 0 },
        knowledge: { items: [], more: 0 },
        problems: [],
        commits: [],
      };

      const areas = buildBoardAreas({ plan, documents, news });
      const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
      expect(cp1.data.fresh).toBe(true);
    });
  });

  describe('extractFreshSets', () => {
    it('extracts fresh document names and commit SHAs from news', () => {
      const news: WhatsNewView = {
        reader: 'user',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T10:00:00Z',
        basis: 'last-look',
        empty: false,
        plan: { items: [], more: 0 },
        documents: { items: [{ name: 'spec.md', kind: 'markdown', change: 'added', at: '2026-10-24T11:00:00Z' }], more: 0 },
        knowledge: { items: [], more: 0 },
        problems: [],
        commits: [
          {
            repo: 'core',
            more: 0,
            commits: [{ sha: 'fe0123456789abcd', subject: 'Fix', author: 'Dev', at: '2026-10-24T11:15:00Z' }],
          },
        ],
      };

      const { isDocFresh, isCommitFresh } = extractFreshSets(news);
      expect(isDocFresh({ id: '1', title: 'Spec', filename: 'spec.md', role: 'design', status: 'draft', createdAt: '', updatedAt: '' })).toBe(true);
      expect(isDocFresh({ id: '2', title: 'Other', filename: 'other.md', role: 'design', status: 'draft', createdAt: '', updatedAt: '' })).toBe(false);
      expect(isCommitFresh('fe0123456789abcd')).toBe(true);
      expect(isCommitFresh('fe01234')).toBe(true);
      expect(isCommitFresh('9999999')).toBe(false);
    });

    it('returns false for everything when news is empty or undefined', () => {
      const { isDocFresh: unDefDoc, isCommitFresh: unDefCommit } = extractFreshSets(undefined);
      expect(unDefDoc({ id: '1', title: 'Spec', filename: 'spec.md', role: 'design', status: 'draft', createdAt: '', updatedAt: '' })).toBe(false);
      expect(unDefCommit('fe01234')).toBe(false);

      const emptyNews: WhatsNewView = {
        reader: 'user',
        at: '2026-10-24T12:00:00Z',
        from: '2026-10-24T10:00:00Z',
        basis: 'last-look',
        empty: true,
        plan: { items: [], more: 0 },
        documents: { items: [], more: 0 },
        knowledge: { items: [], more: 0 },
        problems: [],
        commits: [],
      };
      const { isDocFresh, isCommitFresh } = extractFreshSets(emptyNews);
      expect(isDocFresh({ id: '1', title: 'Spec', filename: 'spec.md', role: 'design', status: 'draft', createdAt: '', updatedAt: '' })).toBe(false);
      expect(isCommitFresh('fe01234')).toBe(false);
    });
  });
});
