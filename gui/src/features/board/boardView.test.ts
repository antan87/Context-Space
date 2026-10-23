import { describe, expect, it } from 'vitest';
import type { PlanFileCheckpoint, PlanFileView } from '../plan/planFile.js';
import type { BoardCard } from './boardData.js';
import { BOARD_SIZE, boardLayout, isFolded, nodeRects, type BoardNode } from './boardLayout.js';
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

  it('is the one thing a group is, open or folded, when there is no checkpoint to open on', () => {
    const brief = { id: 'd1', title: 'Brief', role: 'design', status: 'approved', scope: {}, summary: 'About.', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } as const;
    const folded = boardLayout({ documents: [brief, { ...brief, id: 'd2', title: 'More' }], board: { revision: 1, cards: [note(1)], links: [], positions: {} }, now: 0 });
    const opened = boardLayout({ documents: [brief, { ...brief, id: 'd2', title: 'More' }], board: { revision: 1, cards: [note(1)], links: [], positions: {} }, now: 0, folds: { 'lane:documents': true } });
    expect(openingNodeId(folded)).toBe('lane:documents');
    expect(openingNodeId(opened)).toBe('lane:documents');
  });

  it('is nothing for an empty board', () => {
    expect(openingNodeId([])).toBeUndefined();
    expect(openingView([], SIZE)).toBeNull();
  });
});

describe('openingView, for a board whose groups all fit', () => {
  const brief = { id: 'd1', title: 'Brief', role: 'design', status: 'approved', scope: {}, summary: 'About.', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } as const;
  const lane = (repoName: string) => ({ repo: repoName, more: 0, commits: [{ sha: 'a1b2c3d4e5', author: 'Anna', subject: 'Write it', at: '2026-10-23T08:50:00.000Z' }] });
  const newsOf = (...repos: string[]) => ({
    reader: 'user', at: '2026-10-23T09:00:00.000Z', from: '2026-10-23T07:00:00.000Z', basis: 'last-look', plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 },
    problems: [], empty: false, commits: repos.map(lane),
  } as const);
  /** The documents, one checkpoint and one repository: three columns, 1000 wide. */
  const small = boardLayout({ plan: plan(checkpoints(['Under way', false])), documents: [brief], news: newsOf('api') });
  const SMALL_IDS = ['lane:documents', 'checkpoint:under-way', 'lane:commits:api'];

  it('opens on every group, from the first to the last, side by side', () => {
    const view = openingView(small, SIZE)!;
    for (const id of SMALL_IDS) expect(inside(onScreen(small, id, view)), id).toBe(true);
    // At the zoom that fits them, never past life size: 1000 units in 1200 pixels with the margin leaves room to spare.
    expect(view.zoom).toBe(1);
    // Centred across, and with the top of the row at the top margin.
    const [first, , last] = SMALL_IDS.map((id) => onScreen(small, id, view));
    expect(first.x - 0).toBeCloseTo(SIZE.width - (last.x + last.width), 5);
    for (const id of SMALL_IDS) expect(onScreen(small, id, view).y, id).toBeCloseTo(SIZE.height * OPENING.margin, 5);
  });

  it('zooms out to fit them when the view is narrower than they are, down to the smallest zoom that is easy to read', () => {
    const narrow = { width: 1100, height: 700 };
    const view = openingView(small, narrow)!;
    expect(view.zoom).toBeCloseTo((narrow.width * (1 - 2 * OPENING.margin)) / 1000, 5);
    expect(view.zoom).toBeLessThan(1);
    for (const id of SMALL_IDS) expect(inside(onScreen(small, id, view), narrow), id).toBe(true);
    // The same at the edge: 1000 units fit at exactly the smallest zoom in a view that is 1000 * 0.7 / 0.88 wide.
    const edge = { width: Math.ceil((1000 * OPENING.allMinZoom) / (1 - 2 * OPENING.margin)) + 1, height: 700 };
    expect(openingView(small, edge)!.zoom).toBeGreaterThanOrEqual(OPENING.allMinZoom - 1e-9);
    for (const id of SMALL_IDS) expect(inside(onScreen(small, id, openingView(small, edge)!), edge), id).toBe(true);
    const tooNarrow = { width: Math.floor((1000 * OPENING.allMinZoom) / (1 - 2 * OPENING.margin)) - 2, height: 700 };
    expect(inside(onScreen(small, 'lane:documents', openingView(small, tooNarrow)!), tooNarrow) && inside(onScreen(small, 'lane:commits:api', openingView(small, tooNarrow)!), tooNarrow)).toBe(false);
  });

  it('opens on a folded group and an open one alike, since the columns are the same', () => {
    const opened = boardLayout({ plan: plan(checkpoints(['Under way', false])), documents: [brief], news: newsOf('api'), folds: { 'lane:documents': true, 'lane:commits:api': true } });
    expect(openingView(opened, SIZE)).toEqual(openingView(small, SIZE));
  });

  it('is not for a board that is wider than the view can show at that zoom: that one opens on the work under way', () => {
    const wide = boardLayout({ plan: plan(checkpoints(['One', true], ['Two', false], ['Three', false], ['Four', false])), documents: [brief], news: newsOf('api') });
    const view = openingView(wide, SIZE)!;
    // Seven columns do not fit 1200 pixels at 0.7; the work is in view, the first column is not.
    expect(inside(onScreen(wide, 'checkpoint:two', view))).toBe(true);
    expect(inside(onScreen(wide, 'lane:documents', view))).toBe(false);
    expect(view.zoom).toBeGreaterThanOrEqual(OPENING.minZoom);
  });

  it('does not count the band of cards under the groups, nor the cards put elsewhere, as columns', () => {
    const withCards = boardLayout({ now: 0, plan: plan(checkpoints(['Under way', false])), documents: [brief], news: newsOf('api'), board: { revision: 1, cards: [note(1), note(2)], links: [], positions: { [note(2).id]: { x: 9000, y: 0 } } } });
    expect(openingView(withCards, SIZE)).toEqual(openingView(small, SIZE));
  });

  it('is today\'s rule when the work under way would be cut off at the bottom of the view', () => {
    const tall = boardLayout({ plan: plan([checkpoint('Big', { steps: Array.from({ length: 6 }, (_, index) => step(`Step ${index}`)) })]), documents: [brief] });
    const short = { width: 1200, height: 240 };
    const view = openingView(tall, short)!;
    expect(inside(onScreen(tall, 'checkpoint:big', view), short)).toBe(true);
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

  it('shows a folded group beside the work, as the one summary it is', () => {
    const view = openingView(nodes, SIZE)!;
    // The documents are a column away from the first checkpoint, not from the one under way: folded or open, they are not in reach.
    expect(inside(onScreen(nodes, 'lane:documents', view))).toBe(false);
    const withCommits = boardLayout({
      plan: plan(checkpoints(['Under way', false])),
      news: { reader: 'user', at: '2026-10-23T09:00:00.000Z', from: '2026-10-23T07:00:00.000Z', basis: 'last-look', plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 }, problems: [], empty: false, commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a1b2c3d4e5', author: 'Anna', subject: 'Write it', at: '2026-10-23T08:50:00.000Z' }] }] },
    });
    const next = openingView(withCommits, SIZE)!;
    expect(isFolded(withCommits.find((node) => node.id === 'lane:commits:api')!)).toBe(true);
    expect(inside(onScreen(withCommits, 'lane:commits:api', next))).toBe(true);
    expect(inside(onScreen(withCommits, 'checkpoint:under-way', next))).toBe(true);
  });

  it('does not change what it opens on when a group opens or folds, so the view does not follow the user\'s choices', () => {
    const base = openingNodeId(nodes);
    for (const folds of [{ 'checkpoint:later': true }, { 'checkpoint:under-way': false }, { 'lane:documents': true }]) expect(openingNodeId(boardLayout({ plan: plan(checkpoints(['Done one', true], ['Under way', false], ['Later', false], ['Much later', false], ['Last', false])), folds })), JSON.stringify(folds)).toBe(base);
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
    // A board too wide to open on all of it: the work, and what is beside it, in the middle of the view.
    const view = openingView(nodes, SIZE)!;
    const frame = onScreen(nodes, 'checkpoint:under-way', view);
    expect(frame.x + frame.width / 2).toBeCloseTo(SIZE.width / 2, 5);
    expect(frame.y + frame.height / 2).toBeCloseTo(SIZE.height / 2, 5);
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
