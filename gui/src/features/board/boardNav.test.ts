import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import { areaBoardLayout, areaRowOf, buildBoardAreas, type BoardArea } from './boardAreas.js';
import type { BoardCard, BoardView } from './boardData.js';
import {
  buildBoardNav,
  readNavMode,
  readNavOpen,
  sidebarDock,
  totalBoardWaiting,
  writeNavMode,
  writeNavOpen,
  NAV_MODE_KEY,
  NAV_OPEN_KEY,
  SIDEBAR,
} from './boardNav.js';

function stubStorage(initial: Record<string, string> = {}, fails = false) {
  const data = new Map(Object.entries(initial));
  const refuse = () => { throw new Error('Storage is not available.'); };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => (fails ? refuse() : data.get(key) ?? null),
      setItem: (key: string, value: string) => (fails ? refuse() : void data.set(key, value)),
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidebarDock', () => {
  it('returns desktop docked state when width is >= 960 (SIDEBAR.width + minStage)', () => {
    expect(sidebarDock(1200)).toEqual({ overlays: false, width: SIDEBAR.width });
    expect(sidebarDock(960)).toEqual({ overlays: false, width: SIDEBAR.width });
  });

  it('returns overlays drawer when width is < 960', () => {
    // 900 px section width: 900 - 48 = 852, clamped to 248
    expect(sidebarDock(900)).toEqual({ overlays: true, width: 248 });
    // 280 px section width: 280 - 48 = 232
    expect(sidebarDock(280)).toEqual({ overlays: true, width: 232 });
    // 220 px section width: 220 - 48 = 172, clamped to min 200
    expect(sidebarDock(220)).toEqual({ overlays: true, width: 200 });
  });

  it('handles zero or unmeasured width safely', () => {
    expect(sidebarDock(0)).toEqual({ overlays: false, width: SIDEBAR.width });
    expect(sidebarDock(-1)).toEqual({ overlays: false, width: SIDEBAR.width });
  });
});

describe('storage helpers', () => {
  it('reads open by default unless set to closed', () => {
    const data = stubStorage();
    expect(readNavOpen()).toBe(true);
    writeNavOpen(false);
    expect(data.get(NAV_OPEN_KEY)).toBe('closed');
    expect(readNavOpen()).toBe(false);
    writeNavOpen(true);
    expect(data.get(NAV_OPEN_KEY)).toBe('open');
    expect(readNavOpen()).toBe(true);
  });

  it('reads mode category by default unless set to area', () => {
    const data = stubStorage();
    expect(readNavMode()).toBe('category');
    writeNavMode('area');
    expect(data.get(NAV_MODE_KEY)).toBe('area');
    expect(readNavMode()).toBe('area');
    writeNavMode('category');
    expect(readNavMode()).toBe('category');
  });

  it('safely handles missing or failing storage', () => {
    stubStorage({}, true);
    expect(readNavOpen()).toBe(true);
    expect(readNavMode()).toBe('category');
    expect(() => writeNavOpen(false)).not.toThrow();
    expect(() => writeNavMode('area')).not.toThrow();
  });
});

describe('buildBoardNav', () => {
  const sampleAreas: BoardArea[] = [
    {
      id: 'checkpoint:export-csv',
      kind: 'checkpoint',
      checkpointKey: 'export-csv',
      data: {
        kind: 'checkpoint',
        title: 'Export to CSV',
        done: false,
        current: true,
        stepsDone: 1,
        stepsTotal: 3,
        waitingCount: 1,
        noteCount: 1,
        fileCount: 2,
        pictureCount: 1,
        documentCount: 2,
        commitCount: 1,
        archivedCount: 0,
        pictures: [],
        fresh: false,
      },
      planItems: {
        steps: [
          { key: 'step-1', text: 'Write the CSV writer', done: true },
          { key: 'step-2', text: 'Background job queue', done: false },
        ],
        decisions: [
          {
            key: 'timezone',
            question: 'Which time zone should export timestamps use?',
            done: false,
            suggested: ['UTC', 'Local time'],
          },
        ],
        waitingKeys: ['timezone'],
      },
      documents: [
        {
          id: 'doc-req',
          title: 'Export Requirements',
          role: 'requirements',
          status: 'approved',
          summary: 'Up to 50,000 rows.',
          scope: {},
          filename: 'docs/req.md',
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T00:00:00Z',
        },
        {
          id: 'doc-ext',
          title: 'External Spec',
          role: 'reference',
          status: 'draft',
          summary: 'Online spec for CSV formatting.',
          scope: {},
          url: 'https://example.com/spec',
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T00:00:00Z',
        },
      ],
      repos: [
        {
          repo: {
            repo: 'billing-api',
            commits: [],
            more: 0,
          },
          commits: [
            {
              sha: 'a91f2e0c4d5b',
              subject: 'Add CSV stream formatter',
              author: 'Anna',
              at: '2026-10-24T12:00:00Z',
            },
          ],
          laneId: 'lane:commits:billing-api',
          cards: [
            {
              id: 'commit:billing-api:a91f2e0c4d5b',
              type: 'commit',
              height: 72,
              data: {
                sha: 'a91f2e0',
                subject: 'Add CSV stream formatter',
                author: 'Anna',
                at: '2026-10-24T12:00:00Z',
              },
            },
          ],
        },
      ],
      cards: [
        {
          id: 'note-1',
          kind: 'note',
          title: 'Export memory caveat',
          body: 'Ensure streaming response is flushed properly.',
          pinned: false,
          archived: false,
          by: 'user',
          at: '2026-10-24T10:00:00Z',
          updatedBy: 'user',
          updatedAt: '2026-10-24T10:00:00Z',
        },
        {
          id: 'file-pic-1',
          kind: 'file',
          path: 'assets/diagram.png',
          title: 'Architecture Diagram',
          description: 'Flowchart of the CSV export worker.',
          pinned: false,
          archived: false,
          by: 'codex',
          at: '2026-10-24T10:10:00Z',
          updatedBy: 'codex',
          updatedAt: '2026-10-24T10:10:00Z',
        },
        {
          id: 'file-doc-1',
          kind: 'file',
          path: 'docs/guide.md',
          title: 'Export Guide',
          description: 'User documentation for exports.',
          pinned: false,
          archived: false,
          by: 'codex',
          at: '2026-10-24T10:20:00Z',
          updatedBy: 'codex',
          updatedAt: '2026-10-24T10:20:00Z',
        },
      ],
      archivedCount: 0,
      allMemberNodeIds: ['checkpoint:export-csv'],
    },
  ];

  it('computes total waiting count across areas', () => {
    expect(totalBoardWaiting(sampleAreas)).toBe(1);
  });

  describe('in category mode', () => {
    it('creates sections for each populated category in order', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'category' });
      const titles = sections.map((s) => s.title);
      expect(titles).toEqual([
        'Waiting for you',
        'Areas',
        'Pictures & pages',
        'Documents',
        'Notes',
        'Commits',
      ]);
    });

    it('aligns nodeId for waiting decisions with area frame id', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'category' });
      const waitingSection = sections.find((s) => s.id === 'category:waiting');
      expect(waitingSection?.items[0].nodeId).toBe('checkpoint:export-csv');
      expect(waitingSection?.items[0].title).toBe('Which time zone should export timestamps use?');
      expect(waitingSection?.items[0].badge?.variant).toBe('warning');
    });

    it('sets readerTarget for documents with filenames and omits for external links', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'category' });
      const docSection = sections.find((s) => s.id === 'category:documents');
      const reqDoc = docSection?.items.find((i) => i.id.includes('doc-req'));
      const extDoc = docSection?.items.find((i) => i.id.includes('doc-ext'));

      expect(reqDoc?.readerTarget).toEqual({
        path: 'docs/req.md',
        title: 'Export Requirements',
        card: 'document:doc-req',
        source: 'doc-req',
      });
      expect(extDoc?.readerTarget).toBeUndefined();
    });

    it('categorizes image files into Pictures & pages', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'category' });
      const picSection = sections.find((s) => s.id === 'category:pictures');
      expect(picSection?.items[0].title).toBe('Architecture Diagram');
      expect(picSection?.items[0].fileType).toBe('image');
      expect(picSection?.items[0].readerTarget?.path).toBe('assets/diagram.png');
    });

    it('filters items with multi-token query across title, path, and text', () => {
      const filtered = buildBoardNav(sampleAreas, { mode: 'category', query: 'architecture diagram' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Pictures & pages');
      expect(filtered[0].items[0].title).toBe('Architecture Diagram');
    });

    it('filters commits by author or sha', () => {
      const filtered = buildBoardNav(sampleAreas, { mode: 'category', query: 'Anna' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Commits');
      expect(filtered[0].items[0].title).toBe('Add CSV stream formatter');
    });

    it('normalizes uppercase commit SHAs in readerTarget.commit.sha', () => {
      const testArea: BoardArea = {
        ...sampleAreas[0],
        repos: [
          {
            repo: { repo: 'billing', commits: [], more: 0 },
            commits: [
              {
                sha: 'ABCDEF1234567890',
                subject: 'Uppercase SHA commit',
                author: 'Anna',
                at: '2026-10-24T12:00:00Z',
              },
            ],
            cards: [],
          },
        ],
      };
      const items = buildBoardNav([testArea], { mode: 'category' })
        .flatMap((s) => s.items)
        .filter((i) => i.category === 'commits');
      expect(items).toHaveLength(1);
      expect(items[0].readerTarget?.commit?.sha).toBe('abcdef1234567890');
      expect(items[0].readerTarget?.path).toBe('billing · abcdef1');
    });

    it('omits readerTarget for invalid commit node IDs (such as repo ".." or "a/b")', () => {
      const testArea: BoardArea = {
        ...sampleAreas[0],
        repos: [
          {
            repo: { repo: '..', commits: [], more: 0 },
            commits: [
              {
                sha: 'a91f2e0c4d5b',
                subject: 'Dot dot repo',
                author: 'Anna',
                at: '2026-10-24T12:00:00Z',
              },
            ],
            cards: [],
          },
          {
            repo: { repo: 'a/b', commits: [], more: 0 },
            commits: [
              {
                sha: 'b2c3d4e5f678',
                subject: 'Slash repo',
                author: 'Anna',
                at: '2026-10-24T12:00:00Z',
              },
            ],
            cards: [],
          },
        ],
      };
      const items = buildBoardNav([testArea], { mode: 'category' })
        .flatMap((s) => s.items)
        .filter((i) => i.category === 'commits');
      expect(items).toHaveLength(2);
      expect(items[0].readerTarget).toBeUndefined();
      expect(items[1].readerTarget).toBeUndefined();
    });
  });

  describe('in area mode', () => {
    it('creates a section per area with grouped child items', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'area' });
      expect(sections).toHaveLength(1);
      expect(sections[0].id).toBe('area:checkpoint:export-csv');
      expect(sections[0].title).toBe('Export to CSV');
      expect(sections[0].items.length).toBeGreaterThan(0);
    });

    it('uses area-specific subtitles for items', () => {
      const sections = buildBoardNav(sampleAreas, { mode: 'area' });
      const items = sections[0].items;

      const waitingItem = items.find((i) => i.category === 'waiting');
      expect(waitingItem?.subtitle).toBe('Waits for your answer');

      const commitItem = items.find((i) => i.category === 'commits');
      expect(commitItem?.subtitle).toBe('billing-api · Anna');

      const fileItem = items.find((i) => i.title === 'Architecture Diagram');
      expect(fileItem?.subtitle).toBe('assets/diagram.png');
    });

    it('provides a step-in fallback item when an area has no child items', () => {
      const emptyArea: BoardArea = {
        id: 'checkpoint:empty',
        kind: 'checkpoint',
        data: {
          kind: 'checkpoint',
          title: 'Empty Checkpoint',
          done: false,
          current: false,
          stepsDone: 0,
          stepsTotal: 0,
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
        allMemberNodeIds: ['checkpoint:empty'],
      };

      const sections = buildBoardNav([emptyArea], { mode: 'area' });
      expect(sections).toHaveLength(1);
      expect(sections[0].items[0].id).toBe('stepin:checkpoint:empty');
      expect(sections[0].items[0].nodeId).toBeNull();
      expect(sections[0].items[0].subtitle).toBe('Step into area');
    });
  });
});

describe('with the areas the Board builds', () => {
  const plan: PlanFileView = {
    title: 'Reports feature',
    checkpoints: [
      { key: 'perf', title: 'Report rows load fast', done: true, steps: [{ key: 'p1', text: 'Query rows fast', done: true }], decisions: [] },
      {
        key: 'csv',
        title: 'Reports export to CSV',
        done: false,
        steps: [{ key: 'c1', text: 'Write CSV writer', done: true }, { key: 'c2', text: 'Job queue', done: false }],
        decisions: [{ key: 'd1', question: 'Which time zone?' }],
      },
    ],
    steps: [{ key: 'loose1', text: 'Loose step', done: false }],
    decisions: [{ key: 'loose_d1', question: 'Global question?' }],
    waiting: ['d1', 'loose_d1'],
  };

  const document = (id: string, title: string, fields: Partial<WorkDocument> = {}): WorkDocument => ({
    id, title, role: 'requirements', status: 'approved', scope: {}, summary: `Summary of ${title}`,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...fields,
  });

  const card = (id: string, fields: Partial<BoardCard>): BoardCard => ({
    id, kind: 'note', title: id, body: `Body of ${id}`, pinned: false, archived: false, by: 'user', at: '2026-10-01T00:00:00Z',
    updatedBy: 'user', updatedAt: '2026-10-01T00:00:00Z', ...fields,
  });

  const news: WhatsNewView = {
    basis: 'first-look',
    from: '2026-10-01T00:00:00Z',
    at: '2026-10-02T00:00:00Z',
    commits: [
      {
        repo: 'billing',
        more: 0,
        commits: [
          { sha: 'abcdef1234567890', subject: 'Write CSV writer', author: 'Anna', at: '2026-10-01T12:00:00Z' },
          { sha: '1122334455667788', subject: 'General commit', author: 'Bob', at: '2026-10-01T11:00:00Z' },
        ],
      },
    ],
  };

  const board: BoardView = {
    cards: [
      card('note-1', { title: 'Export memory caveat' }),
      card('note-2', { title: 'Perf note', area: 'checkpoint:perf' }),
      card('note-gone', { title: 'An idea we dropped', archived: true }),
      card('pic-1', { kind: 'file', path: 'assets/diagram.png', title: 'Architecture Diagram', description: 'Flow of the worker.' }),
      card('page-1', { kind: 'file', path: 'docs/overview.html', title: 'Overview page', description: 'Start here.', area: 'checkpoint:perf' }),
      card('guide-1', { kind: 'file', path: 'docs/guide.md', title: 'Export Guide', description: 'How to export.' }),
    ],
    positions: {},
    links: [],
  };

  const documents = [
    document('doc-req', 'Export Requirements', { filename: 'docs/req.md' }),
    document('doc-req', 'Export Requirements', { filename: 'docs/req-2.md', status: 'draft' }),
    document('doc-link', 'External Spec', { url: 'https://example.com/spec', role: 'reference' }),
  ];

  it('points every item at a node that its Area draws', () => {
    for (const sources of [{ plan }, {}]) {
      const areas = buildBoardAreas({ ...sources, documents, news, board, showArchived: true });
      const size = { width: 1440, height: 900 };
      const byId = new Map(areas.map((area) => [area.id, area]));
      // A node is found when it is drawn, or once the row that holds it is opened
      const drawn = new Map(areas.map((area) => [area.id, {
        closed: new Set(areaBoardLayout(area, { news, size }).map((node) => node.id)),
        open: (id: string) => {
          const row = areaRowOf(area, { news }, id);
          return row ? new Set(areaBoardLayout(area, { news, size, openRow: row }).map((node) => node.id)) : new Set<string>();
        },
      }]));
      expect(areas.length).toBeGreaterThan(0);

      for (const mode of ['category', 'area'] as const) {
        const items = buildBoardNav(areas, { mode }).flatMap((section) => section.items);
        const aimed = items.filter((item) => item.nodeId !== null);
        // Every kind of thing the index lists is among those it aims at, so the check below proves something for each
        const kinds = new Set(aimed.map((item) => item.category));
        for (const kind of ['documents', 'pictures', 'notes', 'commits'] as const) expect(kinds.has(kind), `${mode}: ${kind}`).toBe(true);
        if (sources.plan) expect(kinds.has('waiting')).toBe(true);

        for (const item of aimed) {
          const found = drawn.get(item.areaId);
          expect(byId.has(item.areaId)).toBe(true);
          expect(found?.closed.has(item.nodeId!) || found?.open(item.nodeId!).has(item.nodeId!), `${mode}: ${item.id} aims at ${item.nodeId}, which ${item.areaId} does not draw, even with its row open`).toBe(true);
        }
      }
    }
  });

  it('attaches commit readerTarget with repo and sha to commit items', () => {
    const areas = buildBoardAreas({ plan, documents, news, board });
    const commitItems = buildBoardNav(areas, { mode: 'category' })
      .flatMap((section) => section.items)
      .filter((item) => item.category === 'commits');

    expect(commitItems.length).toBeGreaterThan(0);
    for (const item of commitItems) {
      expect(item.readerTarget).toBeDefined();
      expect(item.readerTarget?.commit).toBeDefined();
      expect(item.readerTarget?.commit?.repo).toBe('billing');
      expect(item.readerTarget?.commit?.sha).toMatch(/^[0-9a-f]{7,64}$/);
      expect(item.readerTarget?.path).toBe(`billing · ${item.readerTarget?.commit?.sha.slice(0, 7)}`);
      expect(item.readerTarget?.title).toBe(item.title);
      expect(item.readerTarget?.card).toBe(item.nodeId);
    }
  });
});
