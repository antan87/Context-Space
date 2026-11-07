import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import {
  AREA_MINI,
  AREA_ROW,
  AREA_SIZE,
  OVERVIEW_FOLD,
  OVERVIEW_INSET,
  areaBoardLayout,
  areaCardHeight,
  areaCounts,
  buildBoardAreas,
  extractFreshSets,
  fitHeroCard,
  foldLabel,
  overviewEdges,
  overviewLayout,
  overviewPlan,
  partitionOverviewTiers,
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

    describe('the focus Area', () => {
      const looseCard = sampleCard('loose-card', 'Tied to nothing');
      const news: WhatsNewView = {
        basis: 'first-look', from: '2026-10-01T00:00:00Z', at: '2026-10-02T00:00:00Z',
        commits: [{ repo: 'billing', more: 0, commits: [{ sha: '1122334455667788', subject: 'General commit', author: 'Bob', at: '2026-10-01T11:00:00Z' }] }],
      };
      const board: BoardView = { cards: [looseCard], positions: {}, links: [] };
      const recently = (key: string) => ({ key, by: 'claude', at: new Date().toISOString() });

      it('is the plan\'s first open checkpoint with nothing set, and is not called Now', () => {
        const csv = buildBoardAreas({ plan: samplePlan }).find((a) => a.data.current)!;
        expect(csv.id).toBe('checkpoint:csv');
        expect(csv.data).toMatchObject({ nowSet: false, focusStep: 'c2' });
      });

      it('moves to the Area of the step someone is working on, which is then Now', () => {
        const areas = buildBoardAreas({ plan: { ...samplePlan, now: recently('s1') } });
        const focus = areas.filter((a) => a.data.current);
        expect(focus.map((a) => a.id)).toEqual(['checkpoint:ship']);
        expect(focus[0]!.data).toMatchObject({ nowSet: true, focusStep: 's1' });
        expect(areas.filter((a) => a.data.nowSet)).toHaveLength(1);
      });

      it('leaves cards and documents tied to nothing where they were, and brings the commits tied to nothing to the focus Area', () => {
        const doc = sampleDoc('doc-loose', 'Loose doc');
        const before = buildBoardAreas({ plan: samplePlan, board, news, documents: [doc] });
        const after = buildBoardAreas({ plan: { ...samplePlan, now: recently('s1') }, board, news, documents: [doc] });
        const where = (areas: BoardArea[], pick: (a: BoardArea) => boolean) => areas.find(pick)!.id;
        expect(where(before, (a) => a.cards.some((c) => c.id === 'loose-card'))).toBe('checkpoint:csv');
        expect(where(after, (a) => a.cards.some((c) => c.id === 'loose-card'))).toBe('checkpoint:csv');
        expect(where(before, (a) => a.documents.some((d) => d.id === 'doc-loose'))).toBe('checkpoint:csv');
        expect(where(after, (a) => a.documents.some((d) => d.id === 'doc-loose'))).toBe('checkpoint:csv');
        expect(where(before, (a) => a.data.commitCount > 0)).toBe('checkpoint:csv');
        expect(where(after, (a) => a.data.commitCount > 0)).toBe('checkpoint:ship');
      });

      it('lights an Area for what changed in the last minute by the clock of the build, whatever time the focus is held at', () => {
        const now = Date.now();
        const card = sampleCard('fresh-card', 'Just added', 'checkpoint:ship', { updatedBy: 'claude', updatedAt: new Date(now - 10_000).toISOString() } as never);
        const areas = buildBoardAreas({ plan: samplePlan, board: { cards: [card], positions: {}, links: [] }, now, focusNow: now - 70_000 });
        expect(areas.find((a) => a.id === 'checkpoint:ship')!.data.fresh).toBe(true);
        // and the focus is the one for the time it was held at
        const held = buildBoardAreas({ plan: { ...samplePlan, now: { key: 's1', by: 'claude', at: new Date(now - 70_000).toISOString() } }, now, focusNow: now - 70_000 });
        expect(held.find((a) => a.data.nowSet)!.id).toBe('checkpoint:ship');
      });

      it('ignores a step that is done, gone, or set more than a day ago', () => {
        for (const now of [recently('c1'), recently('gone'), { key: 's1', by: 'claude', at: new Date(Date.now() - 25 * 3600_000).toISOString() }]) {
          const areas = buildBoardAreas({ plan: { ...samplePlan, now } });
          expect(areas.find((a) => a.data.current)!.id).toBe('checkpoint:csv');
          expect(areas.some((a) => a.data.nowSet)).toBe(false);
        }
      });
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
      kind: 'checkpoint', title: `Checkpoint ${i + 1}: the work of one slice`, done, current: i === (options.done ?? 0), nowSet: false, stepsDone: done ? 3 : 1, stepsTotal: 3,
      waitingCount: 0, noteCount: 0, fileCount: 0, pictureCount: 0, documentCount: 0, commitCount: 0, archivedCount: 0, pictures: [], fresh: false, ...options.data,
    };
    return { id: `area-${i}`, kind: 'checkpoint', data, documents: [], repos: [], cards: [], archivedCount: 0, allMemberNodeIds: [`area-${i}`] };
  });
  /** An Area as it is in a workspace that is being worked on: a preview line and counts. */
  const realistic: Partial<AreaData> = { preview: 'Which time zone should export timestamps use?', noteCount: 2, commitCount: 3 };

  const sizes = { laptop: { width: 1280, height: 700 }, pane: { width: 400, height: 700 }, phone: { width: 390, height: 650 } };

  describe('foldLabel', () => {
    it('returns "Show fewer" when expanded', () => {
      expect(foldLabel({ count: 10, kind: 'done', expanded: true })).toBe('Show fewer');
      expect(foldLabel({ count: 19, kind: 'more', moreCount: 3, doneCount: 16, expanded: true })).toBe('Show fewer');
    });

    it('says both open and finished counts when fold holds both', () => {
      expect(foldLabel({ count: 19, kind: 'more', moreCount: 3, doneCount: 16, expanded: false })).toBe('3 more · 16 done');
      expect(foldLabel({ count: 11, kind: 'more', moreCount: 3, doneCount: 8, expanded: false })).toBe('3 more · 8 done');
    });

    it('says "N done" when only finished ones are folded', () => {
      expect(foldLabel({ count: 16, kind: 'done', doneCount: 16, expanded: false })).toBe('16 done');
      expect(foldLabel({ count: 1, kind: 'done', expanded: false })).toBe('1 done');
    });

    it('says "N more" when only open ones are folded', () => {
      expect(foldLabel({ count: 3, kind: 'more', moreCount: 3, expanded: false })).toBe('3 more');
      expect(foldLabel({ count: 5, kind: 'more', expanded: false })).toBe('5 more');
    });
  });

  describe('overviewPlan', () => {
    it('draws cards where they fit at a readable size, and one-line rows where they do not', () => {
      expect(overviewPlan(manyAreas(1), sizes.laptop).form).toBe('cards');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.laptop).form).toBe('minis');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.pane).form).toBe('rows');
      expect(overviewPlan(manyAreas(3, { data: realistic }), sizes.phone).form).toBe('rows');
      // Eleven realistic cards fit the laptop in four columns, but not the pane or the phone at 0.9
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.laptop).form).toBe('minis');
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.pane).form).toBe('rows');
      expect(overviewPlan(manyAreas(11, { data: realistic }), sizes.phone).form).toBe('rows');
      // Twenty-five fit the laptop as small cards (they used to be two columns of rows)
      expect(overviewPlan(manyAreas(25, { data: realistic }), sizes.laptop).form).toBe('minis');
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
      // In W2: Focus area is hero at top, lower tier areas are below it side by side
      expect(three.nodes[0]!.type).toBe('area');
      expect(three.nodes[0]!.position.y).toBe(0);
      expect(three.nodes[1]!.position.y).toBe(three.nodes[2]!.position.y);
      expect(three.viewport!.zoom).toBe(1);
      const wide = overviewPlan(manyAreas(8, { data: realistic }), { width: 1440, height: 900 });
      expect(wide.form).toBe('minis');
      expect(new Set(wide.nodes.slice(1).map((node) => node.position.x)).size).toBeGreaterThanOrEqual(2);
    });

    it('draws rows in the order of the Areas, one column in a narrow stage, with all of them in view and none above the other\'s place', () => {
      for (const size of [sizes.pane, sizes.phone]) {
        const plan = overviewPlan(manyAreas(11, { done: 4, data: realistic }), size);
        expect(plan.form).toBe('rows');
        // In W2: Focus area (area-4) is hero at top, open areas (5..10) are in plan order, done (0..3) are folded
        expect(plan.nodes[0]!.id).toBe('area-4');
        expect(plan.nodes.slice(1, -1).map((node) => node.id)).toEqual(['area-5', 'area-6', 'area-7', 'area-8', 'area-9', 'area-10']);
        expect(plan.nodes.at(-1)!.id).toBe(OVERVIEW_FOLD);
        expect(new Set(plan.nodes.map((node) => node.position.x)).size).toBe(1);
        expect(plan.viewport!.zoom).toBe(1);
        const ys = plan.nodes.map((node) => node.position.y);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
        const last = plan.nodes.at(-1)!;
        expect(last.position.y + last.height! + plan.viewport!.y).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom);
        expect(plan.viewport!.x + last.width!).toBeLessThanOrEqual(size.width);
      }
    });

    it('puts the small cards of a stage too small for cards in two columns or more, where one column of rows would not hold them', () => {
      const plan = overviewPlan(manyAreas(25), sizes.laptop);
      expect(plan.form).toBe('minis');
      expect(new Set(plan.nodes.map((node) => node.position.x)).size).toBeGreaterThanOrEqual(2);
      expect(plan.nodes).toHaveLength(25);
      expect(plan.nodes.some((node) => node.type === 'areaFold')).toBe(false);
    });

    it('puts the rows of a stage too short for small cards in more columns, with what does not fit folded', () => {
      for (const size of [{ width: 697, height: 100 }, { width: 900, height: 140 }]) {
        const plan = overviewPlan(manyAreas(11, { data: realistic }), size);
        expect(plan.form).toBe('rows');
        const rows = plan.nodes.filter((node) => node.type === 'areaRow');
        expect(new Set(rows.map((node) => node.position.x)).size).toBeGreaterThanOrEqual(1);
        expect(plan.nodes.at(-1)!.type).toBe('areaFold');
        for (const node of plan.nodes) {
          expect(node.position.y + plan.viewport!.y).toBeGreaterThanOrEqual(0);
          expect(node.position.y + node.height! + plan.viewport!.y).toBeLessThanOrEqual(size.height);
        }
      }
    });

    it('folds the finished Areas into one last row when the rows do not fit, and opens them on request', () => {
      const areas = manyAreas(25, { done: 15 });
      const plan = overviewPlan(areas, sizes.phone);
      expect(plan.form).toBe('rows');
      const fold = plan.nodes.at(-1) as OverviewNode;
      expect(fold.type).toBe('areaFold');
      expect(fold.id).toBe(OVERVIEW_FOLD);
      expect(fold.data).toEqual({ count: 15, kind: 'done', expanded: false });
      // Hero area-15 is first, then area-16..24, then fold
      expect(plan.nodes[0]!.id).toBe('area-15');
      expect(plan.nodes.slice(1, -1).map((node) => node.id)).toEqual(areas.slice(16).map((area) => area.id));
      const last = plan.nodes.at(-1)!;
      expect(last.position.y + last.height! + plan.viewport!.y).toBeLessThanOrEqual(sizes.phone.height - OVERVIEW_INSET.bottom);

      const open = overviewPlan(areas, sizes.phone, { expanded: true });
      expect(open.nodes.filter((node) => node.type === 'areaRow' || node.type === 'area')).toHaveLength(25);
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
      // Area under way is Tier 1 hero, so it is node 0
      expect(plan.nodes[0]!.id).toBe('area-39');
      expect(plan.nodes[0]!.data).toMatchObject({ current: true });
      const fold = plan.nodes.at(-1)!;
      expect(fold.type).toBe('areaFold');
      expect(plan.nodes.length - 1 + (fold.data as { count: number }).count).toBe(40);
      expect(plan.nodes.at(-1)!.position.y + AREA_ROW.height + plan.viewport!.y).toBeLessThanOrEqual(sizes.phone.height - OVERVIEW_INSET.bottom);
    });

    it('does not fold when every row fits, and has no lines between rows', () => {
      const plan = overviewPlan(manyAreas(5, { done: 0 }), sizes.phone);
      expect(plan.nodes.slice(1).every((node) => node.type === 'areaRow')).toBe(true);
      const areas = manyAreas(5);
      expect(overviewEdges(areas, plan.nodes, [{ id: 'l', from: 'area-1', to: 'area-4' }])).toEqual([]);
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
      // For single area hero card, areaCardHeight matches content
      const one = overviewPlan([{ ...manyAreas(1)[0]!, id: 'pics', data: withPictures }], { width: 1440, height: 1200 });
      expect(one.form).toBe('cards');
      expect(one.nodes[0]!.height).toBeGreaterThan(areaCardHeight(bare));
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

  describe('overviewPlan: small cards', () => {
    /** Stage sizes: the board beside the terminal at 1440x900, 1280x800 and 1100x700 (measured in the app), and the ones of the packet. */
    const stages = {
      split1440: { width: 652, height: 856 }, split1280: { width: 572, height: 756 }, split1100: { width: 482, height: 656 },
      narrow: { width: 414, height: 510 }, a678: { width: 678, height: 574 }, a706: { width: 706, height: 474 }, a886: { width: 886, height: 574 }, phone: { width: 390, height: 720 },
    };
    const minisStages = ['split1440', 'split1280', 'split1100', 'a678', 'a706', 'a886'] as const;
    const longTitle = 'Checkpoint: the whole of a long title that goes on to a second line and then a third';
    const withPicture: Partial<AreaData> = { pictures: [{ path: 'a.png', alt: 'A' }], pictureCount: 1 };
    /** Eleven Areas as a workspace has them: long titles, pictures on some, one under way, one with a waiting decision. */
    const eleven = () => manyAreas(11, { done: 1, data: realistic }).map((area, i) => ({
      ...area, data: { ...area.data, ...(i % 3 === 1 ? withPicture : {}), ...(i === 4 ? { waitingCount: 1 } : {}), ...(i === 2 ? { title: longTitle } : {}) },
    }));
    const inside = (plan: ReturnType<typeof overviewPlan>, size: { width: number; height: number }) => {
      const { x, y } = plan.viewport!;
      for (const node of plan.nodes) {
        expect(node.position.x + x).toBeGreaterThanOrEqual(OVERVIEW_INSET.side - 0.01);
        expect(node.position.x + node.width! + x).toBeLessThanOrEqual(size.width - OVERVIEW_INSET.side + 0.01);
        expect(node.position.y + y).toBeGreaterThanOrEqual(OVERVIEW_INSET.top - 0.01);
        expect(node.position.y + node.height! + y).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom + 0.01);
      }
    };
    const overlap = (a: OverviewNode, b: OverviewNode) =>
      a.position.x < b.position.x + b.width! && b.position.x < a.position.x + a.width! && a.position.y < b.position.y + b.height! && b.position.y < a.position.y + a.height!;

    it('uses the form each Split stage size calls for', () => {
      expect(overviewPlan(eleven(), stages.split1440).form).toBe('minis');
      expect(overviewPlan(eleven(), stages.split1280).form).toBe('minis');
      expect(overviewPlan(eleven(), stages.split1100).form).toBe('minis');
      expect(overviewPlan(eleven(), stages.a678).form).toBe('minis');
      expect(overviewPlan(eleven(), stages.a706).form).toBe('minis');
      expect(overviewPlan(eleven(), stages.a886).form).toBe('minis');
      // Two columns of the least width do not fit a narrow pane or a phone
      expect(overviewPlan(eleven(), stages.narrow).form).toBe('rows');
      expect(overviewPlan(eleven(), stages.phone).form).toBe('rows');
      expect(overviewPlan(eleven(), { width: 467, height: 900 }).form).toBe('rows');
      expect(overviewPlan(eleven(), { width: 468, height: 900 }).form).toBe('minis');
    });

    it('keeps the cards whole, level, apart, in the room, at life size and at least as large as the least, in order', () => {
      for (const name of minisStages) {
        const size = stages[name];
        for (const count of [2, 3, 4, 5, 11, 25]) {
          const areas = manyAreas(count, { data: realistic });
          const plan = overviewPlan(areas, size);
          if (plan.form !== 'minis') continue;
          expect(plan.viewport!.zoom).toBe(1);
          inside(plan, size);
          const cards = plan.nodes.filter((node) => node.type === 'areaMini');
          expect(new Set(cards.map((node) => node.height)).size).toBe(1);
          expect(new Set(cards.map((node) => node.width)).size).toBe(1);
          for (const node of cards) {
            expect(node.height).toBeGreaterThanOrEqual(AREA_MINI.minHeight);
            expect(node.height).toBeLessThanOrEqual(AREA_MINI.maxHeight);
            expect(node.width).toBeGreaterThanOrEqual(AREA_MINI.minWidth);
            expect(node.width).toBeLessThanOrEqual(AREA_MINI.maxWidth);
          }
          for (let i = 0; i < plan.nodes.length; i++) for (let j = i + 1; j < plan.nodes.length; j++) expect(overlap(plan.nodes[i]!, plan.nodes[j]!)).toBe(false);
          // Read left to right, line by line, and every Area is there or folded
          const hero = plan.nodes.find((node) => node.type === 'area');
          expect(hero).toBeDefined();
          const fold = plan.nodes.find((node) => node.type === 'areaFold');
          expect((hero ? 1 : 0) + cards.length + ((fold?.data as { count?: number } | undefined)?.count ?? 0)).toBe(count);
          const ys = plan.nodes.map((node) => node.position.y);
          expect(ys).toEqual([...ys].sort((p, q) => p - q));
        }
      }
    });

    it('chooses the fewest columns that are comfortable, and the tallest otherwise', () => {
      // 11 in 652x856: two columns of six lines are comfortable height
      const plan = overviewPlan(eleven(), stages.split1440);
      const minis = plan.nodes.filter((node) => node.type === 'areaMini');
      expect(new Set(minis.map((node) => node.position.x)).size).toBe(2);
      expect(minis[0]!.height).toBeGreaterThanOrEqual(AREA_MINI.comfyHeight);
      // At 1100x700 two columns are used for lower tiers
      const small = overviewPlan(eleven(), stages.split1100);
      const smallMinis = small.nodes.filter((node) => node.type === 'areaMini');
      expect(new Set(smallMinis.map((node) => node.position.x)).size).toBe(2);
      // Two columns of 743x656 are too short, so three are chosen: 226px wide
      const three = overviewPlan(eleven(), { width: 743, height: 656 });
      expect(three.form).toBe('minis');
      const threeMinis = three.nodes.filter((node) => node.type === 'areaMini');
      expect(new Set(threeMinis.map((node) => node.position.x)).size).toBe(3);
      expect(threeMinis[0]!.width).toBe(226);
      expect(threeMinis[0]!.height).toBeGreaterThanOrEqual(AREA_MINI.minHeight);
      // A wide stage with few Areas: hero card + 3 minis
      const few = overviewPlan(manyAreas(4, { data: realistic }), { width: 886, height: 574 });
      expect(few.form).toBe('minis');
    });

    it('centres the grid across the room, at the top of it', () => {
      const plan = overviewPlan(eleven(), { width: 900, height: 900 });
      expect(plan.form).toBe('minis');
      const hero = plan.nodes[0]!;
      expect(hero.position.x * 2 + hero.width!).toBeCloseTo(900, 0);
      expect(hero.position.y).toBe(0);
    });

    it('folds the finished Areas, then the last, into one tile when the cards do not fit; the one under way stays', () => {
      const stage = { width: 482, height: 656 };
      const done = manyAreas(25, { done: 15 });
      const plan = overviewPlan(done, stage);
      expect(plan.form).toBe('minis');
      const fold = plan.nodes.at(-1)!;
      expect(fold.type).toBe('areaFold');
      expect(fold.data).toEqual({ count: 15, kind: 'done', expanded: false });
      expect(plan.nodes.some((node) => node.id === 'area-15')).toBe(true);
      inside(plan, stage);
      const more = overviewPlan(manyAreas(60, { done: 3 }), stage);
      expect(more.form).toBe('minis');
      expect(more.nodes.at(-1)!.data).toMatchObject({ kind: 'more', expanded: false });
      expect(more.nodes.some((node) => node.id === 'area-3')).toBe(true);
      inside(more, stage);
      // The Area under way is never folded, even the last
      const last = manyAreas(60).map((area, i) => ({ ...area, data: { ...area.data, current: i === 59 } }));
      expect(overviewPlan(last, stage).nodes.some((node) => node.id === 'area-59')).toBe(true);
    });

    it('opens the fold below the stage with the cards the size they were, and folds back', () => {
      const stage = { width: 482, height: 656 };
      const areas = manyAreas(25, { done: 15 });
      const shut = overviewPlan(areas, stage);
      const open = overviewPlan(areas, stage, { expanded: true });
      expect(open.form).toBe('minis');
      expect(open.nodes.filter((node) => node.type === 'areaMini' || node.type === 'area')).toHaveLength(25);
      expect(open.nodes.at(-1)!.data).toEqual({ count: 15, kind: 'done', expanded: true });
      expect(open.nodes[1]!.width).toBe(shut.nodes[1]!.width);
      expect(open.nodes[1]!.height).toBe(shut.nodes[1]!.height);
      expect(open.viewport).toEqual(shut.viewport);
      expect(Math.max(...open.nodes.map((node) => node.position.y + node.height!)) + open.viewport!.y).toBeGreaterThan(stage.height - OVERVIEW_INSET.bottom);
    });

    it('draws every Area of a finished workspace, and a work Area without steps', () => {
      const finished = manyAreas(11, { done: 11 });
      const plan = overviewPlan(finished, stages.split1280, { expanded: true });
      expect(plan.form).toBe('minis');
      expect(plan.nodes.filter((node) => node.type === 'areaMini' || node.type === 'area')).toHaveLength(11);
      const work = manyAreas(11).map((area) => ({ ...area, kind: 'work' as const, data: { ...area.data, kind: 'work' as const, stepsTotal: 0, stepsDone: 0 } }));
      const workPlan = overviewPlan(work, stages.split1280, { expanded: true });
      expect(workPlan.nodes.filter((node) => node.type === 'areaMini' || node.type === 'area').every((node) => (node.data as AreaData).kind === 'work')).toBe(true);
    });

    it('leaves a few Areas to the cards where they fit', () => {
      for (const count of [2, 3, 4, 5]) {
        const plan = overviewPlan(manyAreas(count, { data: realistic }), stages.split1280);
        expect(['cards', 'minis']).toContain(plan.form);
        if (plan.form === 'minis') inside(plan, stages.split1280);
      }
    });

    it('draws no lines between small cards', () => {
      const areas = manyAreas(11);
      const plan = overviewPlan(areas, stages.split1280);
      expect(plan.form).toBe('minis');
      expect(overviewEdges(areas, plan.nodes, [{ id: 'l', from: 'area-1', to: 'area-4' }])).toEqual([]);
    });
  });

  describe('overviewEdges', () => {
    it('deduplicates multiple links between the same two areas and ignores intra-area links', () => {
      const areas = buildBoardAreas({ plan: samplePlan });
      const nodes = overviewLayout(areas, { width: 1440, height: 900 }, { expanded: true });

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

  describe('overviewPlan: tiers and acceptance checks', () => {
    it('partitions areas into tiers as a pure function', () => {
      const sample = [
        manyAreas(1, { done: 0 })[0]!, // focus/current
        { ...manyAreas(1)[0]!, id: 'wait', data: { ...manyAreas(1)[0]!.data, current: false, waitingCount: 1, waitingQuestion: 'Which timezone?' } },
        { ...manyAreas(1)[0]!, id: 'news', data: { ...manyAreas(1)[0]!.data, current: false, newsSummary: '2 commits, 1 picture' } },
        { ...manyAreas(1)[0]!, id: 'open-1', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Open step 1', nextOpenStep: 'Write tests' } },
        { ...manyAreas(1)[0]!, id: 'open-2', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Open step 2', nextOpenStep: 'Refactor' } },
        { ...manyAreas(1)[0]!, id: 'done-1', data: { ...manyAreas(1)[0]!.data, current: false, done: true } },
      ];
      const tiers = partitionOverviewTiers(sample);
      expect(tiers.tier1.map((a) => a.id)).toEqual(['area-0']);
      expect(tiers.tier2.map((a) => a.id)).toEqual(['wait']);
      expect(tiers.tier3.map((a) => a.id)).toEqual(['news']);
      expect(tiers.tier4.map((a) => a.id)).toEqual(['open-1', 'open-2']);
      expect(tiers.tier5.map((a) => a.id)).toEqual(['done-1']);

      // Each area appears exactly once across all tiers
      const allIds = [...tiers.tier1, ...tiers.tier2, ...tiers.tier3, ...tiers.tier4, ...tiers.tier5].map((a) => a.id);
      expect(new Set(allIds).size).toBe(sample.length);

      // Empty tier gone
      const noNews = sample.filter((a) => a.id !== 'news');
      expect(partitionOverviewTiers(noNews).tier3).toEqual([]);
    });

    it('nextOpenStep skips headings', () => {
      const plan: PlanFileView = {
        title: 'Plan with headings',
        checkpoints: [{
          key: 'cp1',
          title: 'Checkpoint with heading',
          steps: [
            { key: 'h1', text: 'Section Heading:' },
            { key: 's1', text: 'Real open step', parent: 'h1' },
            { key: 's2', text: 'Another step', parent: 'h1' },
          ],
          decisions: [],
        }],
      };
      const areas = buildBoardAreas({ plan });
      expect(areas[0]!.data.nextOpenStep).toBe('Real open step');
      expect(areas[0]!.data.openSteps?.[0]?.text).toBe('Real open step');
    });

    it('caps Tier 3 to at most 3 Areas with newest changes, preserving Tier 4 plan order', () => {
      const focus = manyAreas(1, { done: 0 })[0]!;
      const newsAreas = [
        { ...manyAreas(1)[0]!, id: 'news-1', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Area 1', newsSummary: '1 commit', newestChangeTime: 100 } },
        { ...manyAreas(1)[0]!, id: 'news-2', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Area 2', newsSummary: '2 commits', newestChangeTime: 400 } },
        { ...manyAreas(1)[0]!, id: 'news-3', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Area 3', newsSummary: '1 doc', newestChangeTime: 200 } },
        { ...manyAreas(1)[0]!, id: 'news-4', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Area 4', newsSummary: '3 commits', newestChangeTime: 500 } },
        { ...manyAreas(1)[0]!, id: 'news-5', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Area 5', newsSummary: '1 note', newestChangeTime: 300 } },
      ];
      const otherOpen = [
        { ...manyAreas(1)[0]!, id: 'open-plain', data: { ...manyAreas(1)[0]!.data, current: false, title: 'Plain open' } },
      ];

      const sample = [focus, ...newsAreas, ...otherOpen];
      const tiers = partitionOverviewTiers(sample);

      // Focus is tier 1
      expect(tiers.tier1.map((a) => a.id)).toEqual(['area-0']);
      // Tier 3 is capped at 3 areas with newest change times: 500 (news-4), 400 (news-2), 300 (news-5)
      expect(tiers.tier3.map((a) => a.id)).toEqual(['news-4', 'news-2', 'news-5']);
      // The remaining areas with news stay in Tier 4 in their original plan order along with other open areas
      expect(tiers.tier4.map((a) => a.id)).toEqual(['news-1', 'news-3', 'open-plain']);
    });

    it('fitHeroCard covers what it draws and leaves out what does not fit whole without mid-line clipping', () => {
      const data: AreaData = {
        kind: 'checkpoint',
        title: 'Feature implementation and test verification for canvas interaction',
        done: false,
        current: true,
        nowSet: true,
        openSteps: [
          { key: 's1', text: 'Step 1: Write initial code', done: false },
          { key: 's2', text: 'Step 2: Add test coverage', done: false },
          { key: 's3', text: 'Step 3: Verification gate', done: false },
        ],
        stepsDone: 0,
        stepsTotal: 3,
        waitingCount: 0,
        noteCount: 1,
        fileCount: 0,
        pictureCount: 0,
        documentCount: 1,
        commitCount: 2,
        archivedCount: 0,
        pictures: [],
        preview: 'feat(board): add responsive node cards and layout',
      };

      // In large room: draws all 3 steps, preview, footer
      const full = fitHeroCard(data, 560, 800);
      expect(full.config.heroShowPreview).toBe(true);
      expect(full.config.heroShowFooter).toBe(true);
      expect(full.config.heroOpenStepLimit).toBe(3);
      expect(full.height).toBeGreaterThan(200);

      // In tightly constrained room: preview is dropped whole, then footer, then steps reduced
      const constrained1 = fitHeroCard(data, 560, full.height - 10);
      expect(constrained1.config.heroShowPreview).toBe(false);
      expect(constrained1.height).toBeLessThan(full.height);

      const constrained2 = fitHeroCard(data, 560, constrained1.height - 10);
      expect(constrained2.config.heroShowFooter).toBe(false);

      const constrained3 = fitHeroCard(data, 560, constrained2.height - 10);
      expect(constrained3.config.heroOpenStepLimit).toBeLessThan(3);
    });

    it('buildBoardAreas maps commits and plan changes from news to their respective Areas', () => {
      const plan: PlanFileView = {
        title: 'Plan with commits in steps',
        checkpoints: [
          {
            key: 'cp1',
            title: 'First Focus Checkpoint',
            steps: [{ key: 's1', text: 'First step' }],
          },
          {
            key: 'cp2',
            title: 'Second Checkpoint (Board Interaction)',
            steps: [{ key: 's2', text: 'Implemented board feature (706fc9f)' }],
          },
        ],
      };

      const news: WhatsNewView = {
        reader: 'tester',
        at: '2026-11-07T12:00:00Z',
        from: '2026-11-06T12:00:00Z',
        basis: 'last-look',
        empty: false,
        problems: [],
        plan: {
          more: 0,
          items: [
            { at: '2026-11-07T11:50:00Z', by: 'agent', action: 'added', kind: 'step', key: 's2', text: 'New step in cp2' },
          ],
        },
        documents: { more: 0, items: [] },
        knowledge: { more: 0, items: [] },
        commits: [
          {
            repo: 'NexusFlow',
            more: 0,
            commits: [
              { sha: '706fc9f12345678', author: 'agent', subject: 'feat(board): second area commit', at: '2026-11-07T11:45:00Z' },
            ],
          },
        ],
      };

      const areas = buildBoardAreas({ plan, news });
      expect(areas.length).toBe(2);
      const cp2Area = areas.find((a) => a.id === 'checkpoint:cp2');
      expect(cp2Area).toBeDefined();
      // cp2Area received the commit and plan change, so its newsSummary is populated
      expect(cp2Area!.data.newsSummary).toBeDefined();
      expect(cp2Area!.data.newsSummary).toContain('commit');
    });

    it('fits at listed sizes and counts with nothing overlapping or off screen', () => {
      const testSizes = [
        { name: 'laptop', size: { width: 1280, height: 800 } },
        { name: 'split1440', size: { width: 652, height: 856 } },
        { name: 'split1280', size: { width: 572, height: 756 } },
        { name: 'split1100', size: { width: 482, height: 656 } },
        { name: 'narrow', size: { width: 420, height: 700 } },
      ];
      const counts = [1, 2, 14, 25];

      for (const { name, size } of testSizes) {
        for (const count of counts) {
          const areas = manyAreas(count, { done: Math.floor(count / 3), data: realistic });
          const plan = overviewPlan(areas, size);
          expect(plan.nodes.length).toBeGreaterThan(0);

          for (const node of plan.nodes) {
            // Nothing off screen: check screen coordinates accounting for viewport
            const screenX = node.position.x * plan.viewport!.zoom + plan.viewport!.x;
            const screenY = node.position.y * plan.viewport!.zoom + plan.viewport!.y;
            expect(screenX).toBeGreaterThanOrEqual(OVERVIEW_INSET.side - 0.01);
            expect(screenX + node.width! * plan.viewport!.zoom).toBeLessThanOrEqual(size.width - OVERVIEW_INSET.side + 0.01);
            expect(screenY).toBeGreaterThanOrEqual(OVERVIEW_INSET.top - 0.01);
            expect(screenY + node.height! * plan.viewport!.zoom).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom + 0.01);
          }

          // Nothing overlapping
          for (let i = 0; i < plan.nodes.length; i++) {
            for (let j = i + 1; j < plan.nodes.length; j++) {
              const a = plan.nodes[i]!;
              const b = plan.nodes[j]!;
              const overlap = a.position.x < b.position.x + b.width! && b.position.x < a.position.x + a.width! &&
                              a.position.y < b.position.y + b.height! && b.position.y < a.position.y + a.height!;
              expect(overlap, `Overlap at ${name} count ${count} between node ${a.id} and ${b.id}`).toBe(false);
            }
          }
        }
      }
    });

    it('all-done unfold fits the stage with nothing overflowing the stage bounds', () => {
      const size = { width: 572, height: 756 }; // 1280x800 Split stage size
      const doneAreas = manyAreas(11, { done: 11, data: realistic });
      const plan = overviewPlan(doneAreas, size, { expanded: true });
      expect(plan.nodes.length).toBe(12); // 11 minis + 1 fold

      for (const node of plan.nodes) {
        const screenY = node.position.y * plan.viewport!.zoom + plan.viewport!.y;
        expect(screenY).toBeGreaterThanOrEqual(OVERVIEW_INSET.top - 0.01);
        expect(screenY + node.height! * plan.viewport!.zoom).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom + 0.01);
      }
    });

    it('a Done checkpoint is never the focus card even when plan:own exists', () => {
      const plan: PlanFileView = {
        title: 'Plan with top-level steps and done checkpoints',
        steps: [{ key: 's1', text: 'Top level step' }],
        decisions: [],
        checkpoints: [
          { key: 'cp1', title: 'Done Checkpoint 1', done: true, steps: [{ key: 'c1', text: 'Step 1', done: true }] },
          { key: 'cp2', title: 'Done Checkpoint 2', done: true, steps: [{ key: 'c2', text: 'Step 2', done: true }] },
        ],
      };
      const areas = buildBoardAreas({ plan });
      const tiers = partitionOverviewTiers(areas);
      // Focus hero is plan:own, NEVER a done checkpoint
      expect(tiers.tier1).toHaveLength(1);
      expect(tiers.tier1[0]!.id).toBe('plan:own');
      expect(tiers.tier1[0]!.data.done).toBe(false);
      expect(tiers.tier5.map((a) => a.id)).toEqual(['checkpoint:cp1', 'checkpoint:cp2']);
    });

    it('on narrow stages rows carry their tier text and tier 2 plus tier 3 are capped with no 0 more fold', () => {
      const size = { width: 420, height: 500 }; // narrow stage
      const areas: BoardArea[] = [
        manyAreas(1, { done: 0 })[0]!, // Tier 1 hero
        { ...manyAreas(1)[0]!, id: 'wait-1', data: { ...manyAreas(1)[0]!.data, current: false, waitingCount: 1, waitingQuestion: 'Which font?' } },
        { ...manyAreas(1)[0]!, id: 'wait-2', data: { ...manyAreas(1)[0]!.data, current: false, waitingCount: 2, waitingQuestion: 'Which color?' } },
        { ...manyAreas(1)[0]!, id: 'news-1', data: { ...manyAreas(1)[0]!.data, current: false, newsSummary: '2 commits, 1 picture', newestChangeTime: 500 } },
        { ...manyAreas(1)[0]!, id: 'news-2', data: { ...manyAreas(1)[0]!.data, current: false, newsSummary: '1 commit', newestChangeTime: 400 } },
        { ...manyAreas(1)[0]!, id: 'open-1', data: { ...manyAreas(1)[0]!.data, current: false, nextOpenStep: 'Implement tests' } },
        { ...manyAreas(1)[0]!, id: 'open-2', data: { ...manyAreas(1)[0]!.data, current: false, nextOpenStep: 'Deploy feature' } },
      ];
      const plan = overviewPlan(areas, size);
      expect(plan.form).toBe('rows');

      // Check tier assignment on rows
      const rowNodes = plan.nodes.filter((n) => n.type === 'areaRow');
      for (const row of rowNodes) {
        expect([2, 3, 4]).toContain(row.data.tier);
        if (row.id === 'wait-1' || row.id === 'wait-2') expect(row.data.tier).toBe(2);
        if (row.id === 'news-1' || row.id === 'news-2') expect(row.data.tier).toBe(3);
        if (row.id === 'open-1' || row.id === 'open-2') expect(row.data.tier).toBe(4);
      }

      // Check fold node exists and count is never 0
      const fold = plan.nodes.find((n) => n.type === 'areaFold');
      if (fold) {
        expect(fold.data.count).toBeGreaterThan(0);
      }

      // Check nothing overflows stage
      for (const node of plan.nodes) {
        const screenY = node.position.y * plan.viewport!.zoom + plan.viewport!.y;
        expect(screenY + node.height! * plan.viewport!.zoom).toBeLessThanOrEqual(size.height - OVERVIEW_INSET.bottom + 0.01);
      }
    });
  });
});
