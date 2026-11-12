import { describe, expect, it } from 'vitest';

import {
  buildWorkspaceFilesArea,
  classifyWorkspaceFile,
  FILES_AREA_ID,
  formatWorkspaceFileCounts,
  groupWorkspaceFiles,
  isOwnGeneratedFile,
  WORKSPACE_FILE_ROW_IDS,
} from './workspaceFilesArea.js';
import { buildBoardAreas, partitionOverviewTiers } from './boardAreas.js';
import { areaCountItems, resolveCountTarget } from './boardCountNav.js';
import { areaBoardLayout, areaLayout, areaRows, areaStage } from './boardRows.js';
import { buildBoardNav } from './boardNav.js';
import { collectAreaReaderTargets } from './boardReaderLayout.js';
import { isCardId, type BoardCard, type BoardFile } from './boardData.js';
import type { PlanFileView } from '../plan/planFile.js';

function realFileCard(id: string, filePath: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    kind: 'file',
    path: filePath,
    title: filePath.split('/').pop() ?? filePath,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    by: 'ai',
    x: 0,
    y: 0,
    ...overrides,
  } as BoardCard;
}

describe('workspaceFilesArea classification and exclusions', () => {
  it('classifies Documents, Pages, Pictures (including .svg) and ignores source/config files', () => {
    expect(classifyWorkspaceFile('PLAN.md')).toBe('documents');
    expect(classifyWorkspaceFile('docs/notes.txt')).toBe('documents');
    expect(classifyWorkspaceFile('specs/report.pdf')).toBe('documents');
    expect(classifyWorkspaceFile('pages/demo.html')).toBe('pages');
    expect(classifyWorkspaceFile('pages/legacy.HTM')).toBe('pages');
    expect(classifyWorkspaceFile('shots/one.png')).toBe('pictures');
    expect(classifyWorkspaceFile('shots/two.jpg')).toBe('pictures');
    expect(classifyWorkspaceFile('shots/three.jpeg')).toBe('pictures');
    expect(classifyWorkspaceFile('shots/four.gif')).toBe('pictures');
    expect(classifyWorkspaceFile('shots/five.webp')).toBe('pictures');
    expect(classifyWorkspaceFile('icons/logo.svg')).toBe('pictures');
    expect(classifyWorkspaceFile('src/index.ts')).toBeNull();
    expect(classifyWorkspaceFile('package.json')).toBeNull();
  });

  it('drops generated and ContextSpace files while keeping PLAN.md in', () => {
    expect(isOwnGeneratedFile('PLAN.md')).toBe(false);
    expect(isOwnGeneratedFile('docs/PLAN.md')).toBe(false);

    for (const generated of [
      'AGENTS.md',
      'CLAUDE.md',
      'WORKSPACE.md',
      'contextspace-board.json',
      'contextspace-work.json',
      'contextspace-knowledge.md',
      'contextspace-plan.json',
      'nexusflow-notes.md',
      '.agents/skills/review/SKILL.md',
      '.claude/skills/review/SKILL.md',
      '.claude/agents/helper.md',
      '.contextspace/notes.md',
      '.github/copilot-instructions.md',
      '.github/instructions/ts.instructions.md',
    ]) {
      expect(isOwnGeneratedFile(generated)).toBe(true);
    }
  });

  it('groups newest-first, deduplicates against real file cards, and respects excludePaths for WF2', () => {
    const files = [
      { path: 'AGENTS.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: 'CLAUDE.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: '.agents/skills/dev/SKILL.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: '.claude/notes.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: '.github/copilot-instructions.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: 'contextspace-knowledge.md', modifiedAt: '2026-11-12T12:00:00.000Z', size: 10 },
      { path: 'PLAN.md', modifiedAt: '2026-11-12T08:00:00.000Z', size: 120 },
      { path: 'docs/new.txt', modifiedAt: '2026-11-12T11:30:00.000Z', size: 50 },
      { path: 'docs/card-exists.md', modifiedAt: '2026-11-12T11:45:00.000Z', size: 40 },
      { path: 'docs/wf2-step-file.pdf', modifiedAt: '2026-11-12T11:50:00.000Z', size: 90 },
      { path: 'pages/older.html', modifiedAt: '2026-11-12T09:00:00.000Z', size: 200 },
      { path: 'pages/newer.htm', modifiedAt: '2026-11-12T11:00:00.000Z', size: 210 },
      { path: 'pics/p1.png', modifiedAt: '2026-11-12T09:00:00.000Z', size: 300 },
      { path: 'pics/p2.svg', modifiedAt: '2026-11-12T11:55:00.000Z', size: 300 },
      { path: 'pics/p3.webp', modifiedAt: '2026-11-12T10:30:00.000Z', size: 300 },
      { path: 'pics/p4.jpg', modifiedAt: '2026-11-12T11:40:00.000Z', size: 300 },
      { path: 'src/app.ts', modifiedAt: '2026-11-12T12:00:00.000Z', size: 100 },
    ];

    const grouped = groupWorkspaceFiles(files, {
      existingCards: [realFileCard('11111111-1111-4111-8111-111111111111', 'docs/card-exists.md')],
      excludePaths: ['docs/wf2-step-file.pdf'],
    });

    expect(grouped.documents.map((f) => f.path)).toEqual(['PLAN.md', 'docs/new.txt']);
    expect(grouped.documents[0]).toMatchObject({ name: 'PLAN.md', folder: '' });
    expect(grouped.documents[1]).toMatchObject({ name: 'new.txt', folder: 'docs' });
    expect(grouped.pages.map((f) => f.path)).toEqual(['pages/newer.htm', 'pages/older.html']);
    expect(grouped.pictures.map((f) => f.path)).toEqual(['pics/p2.svg', 'pics/p4.jpg', 'pics/p3.webp', 'pics/p1.png']);
    expect(grouped.pictures[0].fileType).toBe('image');
    expect(grouped.total).toBe(8);
  });

  it('builds summary Area data with non-zero counts and up to 3 newest pictures', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const area = buildWorkspaceFilesArea(
      [
        { path: 'PLAN.md', modifiedAt: '2026-11-12T10:00:00.000Z', size: 10 },
        { path: 'pics/a.png', modifiedAt: '2026-11-12T08:00:00.000Z', size: 10 },
        { path: 'pics/b.svg', modifiedAt: '2026-11-12T11:00:00.000Z', size: 10 },
        { path: 'pics/c.webp', modifiedAt: '2026-11-12T11:30:00.000Z', size: 10 },
        { path: 'pics/d.jpg', modifiedAt: '2026-11-12T11:45:00.000Z', size: 10 },
      ],
      { now },
    );

    expect(area).not.toBeNull();
    expect(area!.id).toBe(FILES_AREA_ID);
    expect(area!.kind).toBe('files');
    expect(area!.data.title).toBe('Workspace files');
    expect(area!.data.pictures.map((p) => p.path)).toEqual(['pics/d.jpg', 'pics/c.webp', 'pics/b.svg']);
    expect(areaCountItems(area!.data).map((c) => c.label)).toEqual(['1 document', '4 pictures']);
    expect(resolveCountTarget(area!, 'documents')).toEqual({ rowId: 'row:ws:documents' });
    expect(resolveCountTarget(area!, 'pictures')).toEqual({ rowId: 'row:ws:pictures' });
  });
});

describe('buildBoardAreas and layout integration for Workspace files', () => {
  it('yields Workspace files Area even when plan cards, assigned documents, and commits are empty', () => {
    const emptyBoard: BoardFile = { version: 1, cards: [] };
    const areas = buildBoardAreas({
      plan: undefined,
      documents: [],
      news: undefined,
      board: emptyBoard,
      workspaceFiles: [{ path: 'PLAN.md', modifiedAt: '2026-11-12T11:00:00.000Z', size: 42 }],
      now: Date.parse('2026-11-12T12:00:00.000Z'),
    });

    expect(areas.map((a) => ({ id: a.id, kind: a.kind, title: a.data.title }))).toEqual([
      { id: FILES_AREA_ID, kind: 'files', title: 'Workspace files' },
    ]);
  });

  it('places Workspace files after plan Areas and never displaces Current/Next-up Area', () => {
    const plan: PlanFileView = {
      source: '',
      title: 'Plan',
      overview: '',
      decisions: [],
      checkpoints: [
        {
          key: 'cp1',
          line: 1,
          title: 'First checkpoint',
          done: false,
          current: false,
          steps: [{ key: 's1', line: 2, text: 'Do step', done: false, kind: 'step', indent: 0, current: false }],
          questions: [],
        },
      ],
      looseSteps: [],
      errors: [],
    };
    const areas = buildBoardAreas({
      plan,
      documents: [],
      news: undefined,
      board: { version: 1, cards: [] },
      workspaceFiles: [{ path: 'PLAN.md', modifiedAt: '2026-11-12T11:00:00.000Z', size: 42 }],
      now: Date.parse('2026-11-12T12:00:00.000Z'),
    });

    expect(areas.map((a) => a.id)).toEqual(['checkpoint:cp1', FILES_AREA_ID]);
    const tiers = partitionOverviewTiers(areas);
    expect(tiers.tier1.map((a) => a.id)).toEqual(['checkpoint:cp1']);
    expect(tiers.tier4.map((a) => a.id)).toEqual([FILES_AREA_ID]);
  });

  it('builds 3 newest-first read-only rows, reader targets, and "+N earlier" overflow inside Workspace files', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const pics = Array.from({ length: 8 }, (_, idx) => ({
      path: `pics/shot-${idx}.png`,
      modifiedAt: new Date(now - (8 - idx) * 60_000).toISOString(),
      size: 100,
    }));
    const areas = buildBoardAreas({
      plan: undefined,
      documents: [],
      news: undefined,
      board: { version: 1, cards: [] },
      workspaceFiles: [
        { path: 'docs/old.md', modifiedAt: new Date(now - 3 * 3_600_000).toISOString(), size: 10 },
        { path: 'PLAN.md', modifiedAt: new Date(now - 2 * 3_600_000).toISOString(), size: 10 },
        { path: 'pages/demo.html', modifiedAt: new Date(now - 1 * 3_600_000).toISOString(), size: 10 },
        ...pics,
      ],
      now,
    });
    const filesArea = areas[0];
    const rows = areaRows(filesArea, { now, size: { width: 960, height: 800 } });

    expect(rows.map((r) => r.title)).toEqual(['Documents', 'Pages', 'Pictures']);
    expect(rows[0].items.map((item) => (item.data as { path?: string }).path)).toEqual(['PLAN.md', 'docs/old.md']);
    expect(rows[0].items[0].data).toMatchObject({ readOnly: true, folder: '', age: '2 h ago' });
    expect(rows[0].items[1].data).toMatchObject({ readOnly: true, folder: 'docs', age: '3 h ago' });
    for (const row of rows) {
      for (const item of row.items) {
        expect(isCardId(item.id)).toBe(false);
      }
    }
    expect(rows[2].moreLabel).toBe('earlier');
    expect(rows[2].items[0].data).toMatchObject({ path: 'pics/shot-7.png' });

    const targets = collectAreaReaderTargets(filesArea);
    expect(targets.map((t) => t.path)).toEqual([
      'PLAN.md',
      'docs/old.md',
      'pages/demo.html',
      ...pics.slice().reverse().map((p) => p.path),
    ]);

    const catSections = buildBoardNav(areas, { mode: 'category' });
    const wsCategoryEntry = catSections.find((s) => s.id === 'category:areas')?.items.find((i) => i.areaId === FILES_AREA_ID);
    expect(wsCategoryEntry?.subtitle).not.toMatch(/steps/i);
    expect(wsCategoryEntry?.subtitle).toContain('2 documents · 1 page · 8 pictures');

    const areaSections = buildBoardNav(areas, { mode: 'area' });
    const wsAreaSection = areaSections.find((s) => s.areaId === FILES_AREA_ID);
    expect(wsAreaSection?.items[0]?.title).toContain('2 documents · 1 page · 8 pictures');
  });

  it('formats compact counts as docs/pages/pictures for tight overview cards', () => {
    expect(
      formatWorkspaceFileCounts({ documentCount: 88, pageCount: 12, pictureCount: 173 }, { compact: true }),
    ).toEqual(['88 docs', '12 pages', '173 pictures']);
    expect(
      formatWorkspaceFileCounts({ documentCount: 1, pageCount: 1, pictureCount: 1 }, { compact: true }),
    ).toEqual(['1 doc', '1 page', '1 picture']);
  });

  it('keeps Documents, Pages, and Pictures all open on the first screen across Split, Board, and pane sizes', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const docs = Array.from({ length: 40 }, (_, i) => ({
      path: `design/evidence/run-${Math.floor(i / 4)}/doc-${String(i + 1).padStart(2, '0')}.md`,
      modifiedAt: new Date(now - (i + 1) * 60_000).toISOString(),
      size: 200,
    }));
    const pages = Array.from({ length: 12 }, (_, i) => ({
      path: `pages/view-${String(i + 1).padStart(2, '0')}.html`,
      modifiedAt: new Date(now - (i + 1) * 120_000).toISOString(),
      size: 400,
    }));
    const pics = Array.from({ length: 60 }, (_, i) => ({
      path: `board-pictures/shot-${String(i + 1).padStart(2, '0')}.png`,
      modifiedAt: new Date(now - (i + 1) * 90_000).toISOString(),
      size: 800,
    }));

    const area = buildWorkspaceFilesArea(
      [
        { path: 'PLAN.md', modifiedAt: new Date(now - 10 * 86_400_000).toISOString(), size: 500 },
        ...docs,
        ...pages,
        ...pics,
      ],
      { now },
    )!;

    const viewports = [
      { name: '1280x800 Split', size: { width: 590, height: 716 } },
      { name: '1100x700 Split', size: { width: 500, height: 616 } },
      { name: '1440x900 Board', size: { width: 1350, height: 816 } },
      { name: '420x800 Pane', size: { width: 390, height: 716 } },
    ];

    for (const vp of viewports) {
      const stage = areaStage(vp.size);
      const nodes = areaBoardLayout(area, { now, size: vp.size });
      const folds = nodes.filter((n) => n.type === 'fold');
      expect(folds, `${vp.name} must not fold any row closed`).toHaveLength(0);

      const fileNodes = nodes.filter((n) => n.type === 'file');
      const docNodes = fileNodes.filter((n) => (n.data as { group?: string }).group === 'documents' || n.id.includes('/doc-') || n.id === 'wsfile:PLAN.md');
      const pageNodes = fileNodes.filter((n) => n.id.startsWith('wsfile:pages/'));
      const picNodes = fileNodes.filter((n) => n.id.startsWith('wsfile:board-pictures/'));

      expect(docNodes.length, `${vp.name} doc count`).toBeGreaterThanOrEqual(4);
      expect(docNodes.length, `${vp.name} doc count`).toBeLessThanOrEqual(6);
      expect(docNodes[0]?.id, `${vp.name} PLAN.md first`).toBe('wsfile:PLAN.md');
      expect(docNodes[0]?.height, `${vp.name} compact doc height`).toBeLessThan(48);

      expect(pageNodes.length, `${vp.name} visible pages`).toBeGreaterThanOrEqual(1);
      expect(picNodes.length, `${vp.name} visible pictures`).toBeGreaterThanOrEqual(2);
      expect(picNodes[0]?.height, `${vp.name} pic thumbnail height`).toBeGreaterThanOrEqual(100);

      // All three "+N earlier" tiles are present when rows overflow.
      const moreIds = nodes.filter((n) => n.type === 'more').map((n) => n.id);
      expect(moreIds).toContain(`${WORKSPACE_FILE_ROW_IDS.documents}:more`);
      expect(moreIds).toContain(`${WORKSPACE_FILE_ROW_IDS.pages}:more`);
      expect(moreIds).toContain(`${WORKSPACE_FILE_ROW_IDS.pictures}:more`);

      // Fits inside one screen with zero overlaps.
      for (const n of nodes) {
        expect(n.position.x + (n.width ?? 0)).toBeLessThanOrEqual(stage.width);
        expect(n.position.y + (n.height ?? 0)).toBeLessThanOrEqual(stage.height);
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const overlapX = a.position.x < b.position.x + (b.width ?? 0) && a.position.x + (a.width ?? 0) > b.position.x;
          const overlapY = a.position.y < b.position.y + (b.height ?? 0) && a.position.y + (a.height ?? 0) > b.position.y;
          expect(overlapX && overlapY, `${vp.name} overlap ${a.id} vs ${b.id}`).toBe(false);
        }
      }
    }

    // Expanding Documents via openRow shows pages of remaining documents.
    const opened = areaLayout(area, {
      now,
      size: { width: 590, height: 716 },
      openRow: WORKSPACE_FILE_ROW_IDS.documents,
      page: 0,
    });
    expect(opened.open?.rowId).toBe(WORKSPACE_FILE_ROW_IDS.documents);
    expect(opened.nodes.filter((n) => n.type === 'file').length).toBeGreaterThan(6);
  });
});
