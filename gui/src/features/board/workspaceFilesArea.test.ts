import { describe, expect, it } from 'vitest';

import {
  buildQualifyingWorkspaceFileMap,
  buildWorkspaceFilesArea,
  classifyWorkspaceFile,
  extractStepFilePaths,
  FILES_AREA_ID,
  formatWorkspaceFileCounts,
  groupWorkspaceFiles,
  isOwnGeneratedFile,
  isWorkspaceFileNodeId,
  stepWorkspaceFileNodeId,
  WORKSPACE_FILE_ROW_IDS,
} from './workspaceFilesArea.js';
import { buildBoardAreas, partitionOverviewTiers } from './boardAreas.js';
import { areaCountItems, resolveCountTarget } from './boardCountNav.js';
import { areaBoardLayout, areaLayout, areaPlace, areaRows, areaStage } from './boardRows.js';
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

describe('WF2 step-named files on step rows, Area counts/miniatures, and exclusions', () => {
  it('places step-named files on steps, excludes them and assigned documents from Workspace files, deduplicates per step, and updates Area counts and miniatures', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      decisions: [],
      waiting: [],
      changes: [],
      now: { key: 's1', by: 'claude', at: new Date(now - 60_000).toISOString() },
      steps: [],
      checkpoints: [
        {
          key: 'cp1',
          title: 'Checkpoint 1',
          done: false,
          steps: [
            {
              key: 's1',
              text: 'Packet: `design/packets/spec.md`, Page: ./pages/demo.html, Pic: `board-pictures/a.png` and `board-pictures/a.png`.',
              done: false,
            },
            {
              key: 's2',
              text: 'Also uses board-pictures/a.png and docs/real-on-s2.md and docs/real-on-s3.md.',
              done: false,
            },
            {
              key: 's3',
              text: 'Only named file docs/only-named.md',
              done: false,
            },
            {
              key: 's4',
              text: 'Done step with `board-pictures/done.png`',
              done: true,
            },
          ],
          decisions: [],
        },
      ],
    };

    const areas = buildBoardAreas({
      plan,
      documents: [
        {
          id: 'doc-assigned',
          title: 'Brief',
          role: 'design',
          status: 'approved',
          scope: { milestoneId: 'cp1' },
          summary: 'Assigned brief',
          filename: 'docs/brief.md',
          createdAt: new Date(now - 3_600_000).toISOString(),
          updatedAt: new Date(now - 3_600_000).toISOString(),
        },
      ],
      board: {
        revision: 1,
        positions: {},
        links: [],
        cards: [
          realFileCard('11111111-1111-4111-8111-111111111111', 'docs/real-on-s2.md', {
            area: 'checkpoint:cp1',
            step: 's2',
          }),
          // Real card on s3 for real-on-s3.md must NOT suppress real-on-s3.md on s2.
          realFileCard('22222222-2222-4222-8222-222222222222', 'docs/real-on-s3.md', {
            area: 'checkpoint:cp1',
            step: 's3',
          }),
        ],
      },
      workspaceFiles: [
        { path: 'PLAN.md', modifiedAt: new Date(now - 60_000).toISOString(), size: 100 },
        { path: 'design/packets/spec.md', modifiedAt: new Date(now - 120_000).toISOString(), size: 100 },
        { path: 'pages/demo.html', modifiedAt: new Date(now - 180_000).toISOString(), size: 100 },
        { path: 'board-pictures/a.png', modifiedAt: new Date(now - 240_000).toISOString(), size: 100 },
        { path: 'board-pictures/done.png', modifiedAt: new Date(now - 300_000).toISOString(), size: 100 },
        { path: 'board-pictures/leftover.png', modifiedAt: new Date(now - 360_000).toISOString(), size: 100 },
        { path: 'docs/real-on-s2.md', modifiedAt: new Date(now - 420_000).toISOString(), size: 100 },
        { path: 'docs/real-on-s3.md', modifiedAt: new Date(now - 480_000).toISOString(), size: 100 },
        { path: 'docs/only-named.md', modifiedAt: new Date(now - 540_000).toISOString(), size: 100 },
        { path: 'docs/brief.md', modifiedAt: new Date(now - 600_000).toISOString(), size: 100 },
      ],
      now,
    });

    const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
    const ws = areas.find((a) => a.id === FILES_AREA_ID)!;

    // Workspace files Area keeps only PLAN.md and board-pictures/leftover.png.
    expect(ws.workspaceFiles!.documents.map((f) => f.path)).toEqual(['PLAN.md']);
    expect(ws.workspaceFiles!.pages).toEqual([]);
    expect(ws.workspaceFiles!.pictures.map((f) => f.path)).toEqual(['board-pictures/leftover.png']);

    // cp1 counts & miniatures include unique step-named files + real cards.
    // Unique pictures in cp1: a.png, done.png -> 2 pictures.
    // Unique non-picture files in cp1: spec.md, demo.html, real-on-s2.md (real), real-on-s3.md (real), only-named.md -> 5 files.
    expect(cp1.data.pictureCount).toBe(2);
    expect(cp1.data.fileCount).toBe(7);
    expect(cp1.data.pictures.map((p) => p.path)).toEqual(['board-pictures/a.png', 'board-pictures/done.png']);
    expect(areaCountItems(cp1.data).map((c) => c.label)).toEqual(['2 pictures', '5 files', '1 document']);
    expect(resolveCountTarget(cp1, 'pictures').stepKey).toBe('s1');

    // Step rows: s1, s2, and s3 (only named file, no real card) are all visible step rows; s4 is in row:done.
    const rows = areaRows(cp1, { now, size: { width: 1200, height: 900 } });
    expect(rows.map((r) => r.id)).toEqual(['row:step:s1', 'row:step:s2', 'row:step:s3', 'lane:documents', 'row:done']);

    const s1Items = rows[0]!.items;
    expect(s1Items.map((i) => (i.data as { path?: string }).path)).toEqual([
      'design/packets/spec.md',
      'pages/demo.html',
      'board-pictures/a.png',
    ]);
    for (const item of s1Items) {
      expect(item.data).toMatchObject({ readOnly: true });
      expect(isCardId(item.id)).toBe(false);
    }

    // s2 has real-on-s2.md once (real card wins), plus step-named a.png and real-on-s3.md.
    const s2Items = rows[1]!.items;
    expect(s2Items.map((i) => (i.data as { path?: string }).path)).toEqual([
      'docs/real-on-s2.md',
      'board-pictures/a.png',
      'docs/real-on-s3.md',
    ]);
    expect(s2Items[0]!.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(isCardId(s2Items[0]!.id)).toBe(true);

    // Done step stays folded in row:done; opening row:done shows done.png.
    const closedNodes = areaBoardLayout(cp1, { now, size: { width: 1200, height: 900 } });
    expect(closedNodes.find((n) => n.id === 'row:done')?.type).toBe('fold');
    const openedDone = areaLayout(cp1, { now, size: { width: 1200, height: 900 }, openRow: 'row:done' });
    expect(openedDone.nodes.some((n) => n.type === 'file' && (n.data as { path?: string }).path === 'board-pictures/done.png')).toBe(true);

    // Reader targets include step-named files for [ / ] navigation.
    const targets = collectAreaReaderTargets(cp1);
    expect(targets.map((t) => t.path)).toContain('design/packets/spec.md');
    expect(targets.map((t) => t.path)).toContain('pages/demo.html');
    expect(targets.map((t) => t.path)).toContain('board-pictures/done.png');
  });

  it('keeps the Now step on the first screen when many steps name files', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const steps = Array.from({ length: 12 }, (_, idx) => ({
      key: `s${idx + 1}`,
      text: `Step ${idx + 1} produces \`board-pictures/shot-${idx + 1}.png\``,
      done: false,
    }));
    const files = Array.from({ length: 12 }, (_, idx) => ({
      path: `board-pictures/shot-${idx + 1}.png`,
      modifiedAt: new Date(now - (idx + 1) * 60_000).toISOString(),
      size: 100,
    }));
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      decisions: [],
      waiting: [],
      changes: [],
      now: { key: 's1', by: 'claude', at: new Date(now - 30_000).toISOString() },
      steps: [],
      checkpoints: [{ key: 'cp1', title: 'Many steps', done: false, steps, decisions: [] }],
    };
    const [cp1] = buildBoardAreas({
      plan,
      board: { revision: 1, positions: {}, links: [], cards: [] },
      workspaceFiles: files,
      now,
    });
    const stage = areaStage({ width: 500, height: 616 });
    const nodes = areaBoardLayout(cp1!, { now, size: { width: 500, height: 616 } });
    const nowNode = nodes.find((n) => n.id === 'row:step:s1');
    expect(nowNode).toBeDefined();
    expect(nowNode!.position.y).toBe(0);
    for (const n of nodes) {
      expect(n.position.y + (n.height ?? 0)).toBeLessThanOrEqual(stage.height);
    }
  });

  it('extracts backticked, plain, and markdown-linked relative paths while ignoring URLs, case mismatches, and unknown files', () => {
    const map = buildQualifyingWorkspaceFileMap([
      { path: 'design/packets/spec.md', modifiedAt: '2026-11-12T10:00:00.000Z', size: 10 },
      { path: 'Docs/UpperCase.md', modifiedAt: '2026-11-12T10:01:00.000Z', size: 10 },
      { path: 'board-pictures/a.png', modifiedAt: '2026-11-12T10:02:00.000Z', size: 10 },
      { path: 'pages/demo.html', modifiedAt: '2026-11-12T10:03:00.000Z', size: 10 },
      { path: 'README.md', modifiedAt: '2026-11-12T10:04:00.000Z', size: 10 },
      { path: 'AGENTS.md', modifiedAt: '2026-11-12T10:05:00.000Z', size: 10 },
    ]);

    const stepText = [
      'Start with `design/packets/spec.md`, then inspect ./board-pictures/a.png.',
      'Also read [Demo](pages/demo.html), check Docs/UpperCase.md; ignore docs/uppercase.md,',
      'ignore https://example.com/design/packets/spec.md, ignore spec.md (basename only),',
      'ignore docs/missing.md and AGENTS.md, mention README.md and `design/packets/spec.md` again.',
    ].join(' ');

    const extracted = extractStepFilePaths(stepText, map);
    expect(extracted.map((f) => f.path)).toEqual([
      'design/packets/spec.md',
      'board-pictures/a.png',
      'pages/demo.html',
      'Docs/UpperCase.md',
      'README.md',
    ]);
  });

  it('resolves overview count targets and areaPlace for open and done step-named files with non-card IDs', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      decisions: [],
      waiting: [],
      changes: [],
      steps: [],
      checkpoints: [
        {
          key: 'cp1',
          title: 'Step targets',
          done: false,
          steps: [
            { key: 's-open', text: 'Inspect `design/spec.md` and `design/spec.md`', done: false },
            { key: 's-dup', text: 'Also reuse `design/spec.md`', done: false },
            { key: 's-done', text: 'Shipped `board-pictures/done.png`', done: true },
          ],
          decisions: [],
        },
      ],
    };

    const [cp1] = buildBoardAreas({
      plan,
      board: { revision: 1, positions: {}, links: [], cards: [] },
      workspaceFiles: [
        { path: 'design/spec.md', modifiedAt: '2026-11-12T11:00:00.000Z', size: 20 },
        { path: 'board-pictures/done.png', modifiedAt: '2026-11-12T11:30:00.000Z', size: 30 },
      ],
      now,
    });
    expect(cp1).toBeDefined();

    // Distinct IDs when two steps share a path; never recognized as persisted card IDs.
    const openId = stepWorkspaceFileNodeId('s-open', 'design/spec.md');
    const dupId = stepWorkspaceFileNodeId('s-dup', 'design/spec.md');
    expect(openId).not.toBe(dupId);
    expect(isWorkspaceFileNodeId(openId)).toBe(true);
    expect(isCardId(openId)).toBe(false);

    // Unique step-named file counts once at Area level even when named on two steps.
    expect(cp1!.data.fileCount).toBe(2);
    expect(cp1!.data.pictureCount).toBe(1);

    const picTarget = resolveCountTarget(cp1!, 'pictures');
    expect(picTarget).toEqual({
      rowId: 'row:done',
      stepKey: 's-done',
      cardId: stepWorkspaceFileNodeId('s-done', 'board-pictures/done.png'),
    });
    const docTarget = resolveCountTarget(cp1!, 'files');
    expect(docTarget).toEqual({
      rowId: 'row:step:s-open',
      stepKey: 's-open',
      cardId: openId,
    });

    // areaPlace locates the done step-named file inside row:done so opening/navigation expands row:done.
    expect(areaPlace(cp1!, { now, size: { width: 1200, height: 900 } }, picTarget.cardId!)).toEqual({
      row: 'row:done',
      page: 0,
    });
  });

  it('never treats root PLAN.md as step-named, keeping it first in Workspace files and out of step rows', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const map = buildQualifyingWorkspaceFileMap([
      { path: 'PLAN.md', modifiedAt: new Date(now - 600_000).toISOString(), size: 100 },
      { path: 'docs/PLAN.md', modifiedAt: new Date(now - 120_000).toISOString(), size: 80 },
      { path: 'board-pictures/a.png', modifiedAt: new Date(now - 60_000).toISOString(), size: 90 },
    ]);

    expect(
      extractStepFilePaths(
        'Check PLAN.md, `./PLAN.md`, (PLAN.md, and [plan](/PLAN.md)); also docs/PLAN.md and board-pictures/a.png.',
        map,
      ).map((f) => f.path),
    ).toEqual(['docs/PLAN.md', 'board-pictures/a.png']);

    const plan: PlanFileView = {
      file: 'PLAN.md',
      source: 'file',
      title: 'Plan',
      intro: '',
      sections: [],
      decisions: [],
      waiting: [],
      changes: [],
      now: { key: 's1', by: 'claude', at: new Date(now - 30_000).toISOString() },
      steps: [],
      checkpoints: [
        {
          key: 'cp1',
          title: 'Plan mentions',
          done: false,
          steps: [
            { key: 's1', text: 'Build board from PLAN.md and `board-pictures/a.png`.', done: false },
            { key: 's2', text: 'Only mentions (PLAN.md, `./PLAN.md`) in text.', done: false },
            { key: 's3', text: 'Done step updating PLAN.md.', done: true },
          ],
          decisions: [],
        },
      ],
    };

    const areas = buildBoardAreas({
      plan,
      board: { revision: 1, positions: {}, links: [], cards: [] },
      workspaceFiles: [
        { path: 'PLAN.md', modifiedAt: new Date(now - 600_000).toISOString(), size: 100 },
        { path: 'docs/other.md', modifiedAt: new Date(now - 30_000).toISOString(), size: 50 },
        { path: 'board-pictures/a.png', modifiedAt: new Date(now - 60_000).toISOString(), size: 90 },
      ],
      now,
    });

    const cp1 = areas.find((a) => a.id === 'checkpoint:cp1')!;
    const ws = areas.find((a) => a.id === FILES_AREA_ID)!;

    expect(ws.workspaceFiles!.documents.map((f) => f.path)).toEqual(['PLAN.md', 'docs/other.md']);
    expect(cp1.stepFiles?.s1?.map((f) => f.path)).toEqual(['board-pictures/a.png']);
    expect(cp1.stepFiles?.s2).toBeUndefined();
    expect(cp1.stepFiles?.s3).toBeUndefined();

    // s2 only mentions PLAN.md, so it stays folded in row:more-steps instead of creating row:step:s2.
    const rows = areaRows(cp1, { now, size: { width: 1200, height: 900 } });
    expect(rows.map((r) => r.id)).toEqual(['row:step:s1', 'row:more-steps', 'row:done']);
    expect(cp1.allMemberNodeIds.some((id) => id.endsWith(':PLAN.md'))).toBe(false);
  });
});
