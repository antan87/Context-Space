import { describe, expect, it } from 'vitest';
import type { PlanFileCheckpoint, PlanFileView } from '../plan/planFile.js';
import type { BoardCard } from './boardData.js';
import { BOARD_SIZE, boardLayout, nodeRects, type BoardNode } from './boardLayout.js';
import { OPENING, openingNodeId, openingView } from './boardView.js';

const slug = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const step = (text: string, done = false) => ({ key: slug(text), text, done });
const checkpoint = (title: string, fields: Partial<PlanFileCheckpoint> = {}): PlanFileCheckpoint => ({ key: slug(title), title, done: false, steps: [], decisions: [], ...fields });
const plan = (checkpoints: PlanFileCheckpoint[], fields: Partial<PlanFileView> = {}): PlanFileView => ({
  file: 'PLAN.md', source: 'file', title: 'Plan', intro: '', sections: [], steps: [], decisions: [], changes: [], checkpoints, waiting: [], ...fields,
});
const note = (n: number): BoardCard => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'note', title: `Note ${n}`, body: '', pinned: false, archived: false,
  by: 'claude', at: '2026-10-23T09:00:00.000Z', updatedBy: 'claude', updatedAt: '2026-10-23T09:00:00.000Z',
});

const SIZE = { width: 1200, height: 700 };
const checkpoints = (...rest: Array<[string, boolean]>) => rest.map(([title, done]) => checkpoint(title, { done, steps: [step('A step', done)] }));
/** Where a node is on the screen once the view is applied. */
const onScreen = (nodes: BoardNode[], id: string, view: { x: number; y: number; zoom: number }) => {
  const rect = nodeRects(nodes).get(id)!;
  return { x: rect.x * view.zoom + view.x, y: rect.y * view.zoom + view.y, width: rect.width * view.zoom, height: rect.height * view.zoom };
};
const inside = (rect: { x: number; y: number; width: number; height: number }, size = SIZE) =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width && rect.y + rect.height <= size.height;

describe('openingNodeId', () => {
  it('is the first checkpoint that is not done', () => {
    const nodes = boardLayout({ plan: plan(checkpoints(['One', true], ['Two', false], ['Three', false])) });
    expect(openingNodeId(nodes)).toBe('checkpoint:two');
  });

  it('is the last checkpoint when all are done', () => {
    expect(openingNodeId(boardLayout({ plan: plan(checkpoints(['One', true], ['Two', true])) }))).toBe('checkpoint:two');
  });

  it('is not the plan\'s own frame while there is a checkpoint, however that frame is marked', () => {
    const nodes = boardLayout({ plan: plan(checkpoints(['One', true]), { steps: [step('Loose')] }) });
    expect(openingNodeId(nodes)).toBe('checkpoint:one');
  });

  it('falls back to the plan\'s own frame, and then to the first card in reading order', () => {
    expect(openingNodeId(boardLayout({ plan: plan([], { steps: [step('Loose')] }) }))).toBe('plan:own');
    const cards = boardLayout({ now: 0, board: { revision: 1, cards: [note(1), note(2)], links: [], positions: { [note(2).id]: { x: -500, y: 100 } } } });
    expect(openingNodeId(cards)).toBe(note(2).id);
  });

  it('is nothing for an empty board', () => {
    expect(openingNodeId([])).toBeUndefined();
    expect(openingView([], SIZE)).toBeNull();
  });
});

describe('openingView', () => {
  const nodes = boardLayout({
    plan: plan(checkpoints(['Done one', true], ['Under way', false], ['Later', false], ['Much later', false], ['Last', false])),
    documents: [{ id: 'd1', title: 'Brief', role: 'design', status: 'approved', scope: {}, summary: 'About.', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
  });

  it('opens on the first checkpoint that is not done, in view', () => {
    const view = openingView(nodes, SIZE)!;
    expect(inside(onScreen(nodes, 'checkpoint:under-way', view))).toBe(true);
  });

  it('is at a zoom you can read, not the zoom that fits everything', () => {
    const view = openingView(nodes, SIZE)!;
    expect(view.zoom).toBeGreaterThanOrEqual(OPENING.minZoom);
    expect(view.zoom).toBeLessThanOrEqual(OPENING.maxZoom);
    // Everything would not fit at that zoom, which is the point.
    const all = [...nodeRects(nodes).values()];
    const width = Math.max(...all.map((rect) => rect.x + rect.width)) - Math.min(...all.map((rect) => rect.x));
    expect(width * view.zoom).toBeGreaterThan(SIZE.width);
  });

  it('shows the checkpoints beside the one under way, and not the ones far from it', () => {
    const view = openingView(nodes, SIZE)!;
    expect(inside(onScreen(nodes, 'checkpoint:done-one', view))).toBe(true);
    expect(inside(onScreen(nodes, 'checkpoint:later', view))).toBe(true);
    expect(inside(onScreen(nodes, 'checkpoint:last', view))).toBe(false);
  });

  it('centres on the work: what it shows is as far from one side as the other', () => {
    const one = boardLayout({ plan: plan(checkpoints(['Only', false])) });
    const view = openingView(one, SIZE)!;
    const frame = onScreen(one, 'checkpoint:only', view);
    expect(frame.x + frame.width / 2).toBeCloseTo(SIZE.width / 2, 5);
    expect(frame.y + frame.height / 2).toBeCloseTo(SIZE.height / 2, 5);
    // A lone frame is not blown up past life size.
    expect(view.zoom).toBe(1);
  });

  it('is the same for the same input', () => {
    expect(openingView(nodes, SIZE)).toEqual(openingView(nodes, SIZE));
  });

  it('includes the cards put near the work', () => {
    const board = {
      revision: 1, cards: [note(1), note(2)], links: [],
      positions: { [note(1).id]: { x: 330, y: 30 }, [note(2).id]: { x: 6000, y: 0 } },
    };
    const withCards = boardLayout({ now: 0, board, plan: plan(checkpoints(['Under way', false])) });
    const view = openingView(withCards, SIZE)!;
    expect(inside(onScreen(withCards, note(1).id, view))).toBe(true);
    expect(inside(onScreen(withCards, note(2).id, view))).toBe(false);
  });

  it('keeps the focus whole in a small view, at the zoom that fits it', () => {
    const tall = boardLayout({ plan: plan([checkpoint('Big', { steps: Array.from({ length: 6 }, (_, index) => step(`Step ${index}`)) })]) });
    const small = { width: 220, height: 200 };
    const view = openingView(tall, small)!;
    expect(view.zoom).toBeLessThan(OPENING.minZoom);
    expect(inside(onScreen(tall, 'checkpoint:big', view), small)).toBe(true);
  });

  it('waits for a view that has a size', () => {
    expect(openingView(nodes, { width: 0, height: 700 })).toBeNull();
    expect(openingView(nodes, { width: 1200, height: 0 })).toBeNull();
  });

  it('uses the frames\' real extent: a column is one card wide', () => {
    expect(OPENING.reach).toBe(BOARD_SIZE.column + BOARD_SIZE.columnGap);
  });
});
