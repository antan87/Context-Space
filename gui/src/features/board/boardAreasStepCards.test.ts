import { describe, expect, it } from 'vitest';

import type { PlanFileView } from '../plan/planFile.js';
import { buildBoardAreas } from './boardAreas.js';
import { areaRows } from './boardRows.js';
import type { BoardCard } from './boardData.js';

// DB4b: a file card linked to a plan item by id sits in that item's Area.
const plan: PlanFileView = {
  title: 'Reports feature',
  store: 'database',
  checkpoints: [
    { key: 'cpaaaa', title: 'First open', done: false, steps: [{ key: 's11111', text: 'Write the writer', done: false }], decisions: [] },
    { key: 'cpbbbb', title: 'Second', done: false, steps: [{ key: 's22222', text: 'Deploy to prod', done: false }], decisions: [] },
  ],
  steps: [],
  decisions: [],
  waiting: [],
} as unknown as PlanFileView;

const card = (id: string, extra: Partial<BoardCard>): BoardCard => ({
  id, kind: 'file', title: id, path: `board-pictures/${id}.png`, pinned: false, archived: false,
  by: 'ai', at: '2026-11-01T00:00:00Z', updatedBy: 'ai', updatedAt: '2026-11-01T00:00:00Z', ...extra,
});

const where = (cards: BoardCard[], id: string, p: PlanFileView = plan, extra: Record<string, unknown> = {}) =>
  buildBoardAreas({ plan: p, board: { revision: 1, positions: {}, links: [], cards }, ...extra })
    .find((a) => a.cards.some((c) => c.id === id))?.id;

describe('a file card linked to a plan item by id', () => {
  it('with a step and no area sits in the step\'s Area, in that step\'s row', () => {
    expect(where([card('pic', { step: 's22222' })], 'pic')).toBe('checkpoint:cpbbbb');
    const area = buildBoardAreas({ plan, board: { revision: 1, positions: {}, links: [], cards: [card('pic', { step: 's22222' })] } }).find((a) => a.id === 'checkpoint:cpbbbb')!;
    const rows = areaRows(area, { now: Date.now(), size: { width: 1200, height: 900 } });
    const stepRow = rows.find((r) => r.id === 'row:step:s22222')!;
    expect(stepRow.items.map((i) => i.id)).toContain('pic');
    expect(rows.find((r) => r.id === 'lane:board')).toBeUndefined();
  });

  // On files, the MCP tool stores a hint step on a card it places by Board link, so there the step must not win.
  it('on a workspace on files a note with a hint step goes where its Board link says', () => {
    const filesPlan = { ...plan, store: undefined } as PlanFileView;
    const note = card('hint', { kind: 'note', path: undefined, step: 's11111' });
    const areas = buildBoardAreas({ plan: filesPlan, board: { revision: 1, positions: {}, links: [{ id: 'l1', from: 'hint', to: 'checkpoint:cpbbbb', by: 'ai', at: '2026-11-01T00:00:00Z' }], cards: [note] } });
    expect(areas.find((a) => a.cards.some((c) => c.id === 'hint'))?.id).toBe('checkpoint:cpbbbb');
    expect(where([card('f', { step: 's22222' })], 'f', filesPlan)).toBe('checkpoint:cpaaaa');
  });

  it('follows its step when its area names another Area', () => {
    expect(where([card('pic', { step: 's22222', area: 'checkpoint:cpaaaa' })], 'pic')).toBe('checkpoint:cpbbbb');
  });

  it('a note with a step follows it too', () => {
    expect(where([card('n', { kind: 'note', path: undefined, step: 's22222' })], 'n')).toBe('checkpoint:cpbbbb');
  });

  it('an unknown step falls back to the area, then to the first open Area', () => {
    expect(where([card('a', { step: 'szzzzz', area: 'checkpoint:cpbbbb' })], 'a')).toBe('checkpoint:cpbbbb');
    expect(where([card('b', { step: 'szzzzz' })], 'b')).toBe('checkpoint:cpaaaa');
  });

  it('a path named in the step text and also linked by card shows once', () => {
    const p = { ...plan, checkpoints: [plan.checkpoints[0]!, { ...plan.checkpoints[1]!, steps: [{ key: 's22222', text: 'Deploy, see `board-pictures/pic.png`', done: false }] }] } as PlanFileView;
    const areas = buildBoardAreas({
      plan: p,
      board: { revision: 1, positions: {}, links: [], cards: [card('pic', { step: 's22222' })] },
      workspaceFiles: [{ path: 'board-pictures/pic.png', modifiedAt: '2026-11-01T00:00:00Z', size: 3 }],
    });
    const area = areas.find((a) => a.id === 'checkpoint:cpbbbb')!;
    expect(area.data.pictureCount).toBe(1);
    expect(area.data.stepFiles?.s22222 ?? []).toEqual([]);
  });
});
