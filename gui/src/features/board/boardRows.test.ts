import { describe, expect, it } from 'vitest';
import type { WorkDocument } from '../../types.js';
import type { PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import { buildBoardAreas, type BoardArea } from './boardAreas.js';
import type { BoardCard, BoardView } from './boardData.js';
import { boardEdges, nodeRects, type BoardNode, type Rect } from './boardLayout.js';
import { ITEM_HEIGHT, READABLE_ZOOM, ROW_SIZE, WAITING_ROW, answersThatFit, areaBoardLayout, areaLayout, areaPlace, areaRowIds, areaRowOf, areaRows, areaStage, areaView, headingKeys, waitingHeight } from './boardRows.js';

const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
const card = (id: string, title: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id, kind: 'note', title, body: `Body for ${title}`, pinned: false, archived: false, by: 'user', at: at(1), updatedBy: 'user', updatedAt: at(1), area: 'checkpoint:cp', ...extra,
} as BoardCard);
const file = (id: string, title: string, extra: Partial<BoardCard> = {}): BoardCard => card(id, title, { kind: 'file', path: `${id}.png`, description: 'd', ...extra } as Partial<BoardCard>);
const doc = (id: string, title: string): WorkDocument => ({
  id, title, role: 'design', status: 'approved', scope: { milestoneId: 'cp' }, summary: `About ${title}`, createdAt: at(1), updatedAt: at(1),
});
const newsOf = (repos = 1, commits = 3): WhatsNewView => ({
  basis: 'stream', at: '2026-10-24T12:00:00Z', from: '2026-10-24T11:00:00Z',
  commits: Array.from({ length: repos }, (_, r) => ({
    repo: r === 0 ? 'api' : `repo${r}`, more: 0,
    commits: Array.from({ length: commits }, (_, c) => ({ sha: `${r}${c}abcdef0`, subject: `Commit ${r}.${c}`, author: 'A', at: `2026-10-24T11:${String(10 + c).padStart(2, '0')}:00Z` })),
  })),
});
const planOf = (open: number, done: number, decisions = 0): PlanFileView => {
  const steps = [
    ...Array.from({ length: done }, (_, i) => ({ key: `d${i}`, text: `Done step ${i}`, done: true })),
    ...Array.from({ length: open }, (_, i) => ({ key: `s${i}`, text: `Open step ${i} with some words`, done: false })),
  ];
  const list = Array.from({ length: decisions }, (_, i) => ({ key: `q${i}`, question: `Question ${i} for you?` }));
  return {
    title: 'P', checkpoints: [
      { key: 'earlier', title: 'Earlier', done: true, steps: [{ key: 'e1', text: 'Earlier step', done: true }], decisions: [] },
      { key: 'cp', title: 'The checkpoint', done: false, steps, decisions: list },
    ], steps: [], decisions: [], waiting: list.map((d) => d.key),
  };
};
const areaOf = (plan: PlanFileView, cards: BoardCard[], opts: { docs?: WorkDocument[]; news?: WhatsNewView; id?: string } = {}) =>
  buildBoardAreas({ plan, documents: opts.docs, news: opts.news, board: { cards, positions: {}, links: [] } as BoardView }).find((a) => a.id === (opts.id ?? 'checkpoint:cp'))!;

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const ids = (nodes: BoardNode[]) => new Set(nodes.map((n) => n.id));
const byId = (nodes: BoardNode[], id: string) => nodes.find((n) => n.id === id)!;
const big = { width: 1600, height: 1200 };

describe('areaBoardLayout v2: which row is which', () => {
  const cards = [
    card('first-old', 'First old', { step: 's0', at: at(1) }),
    card('first-new', 'First new', { step: 's0', at: at(5) }),
    card('second', 'Second', { step: 's1', at: at(2) }),
    card('dangling', 'Dangling', { step: 'nope', at: at(2) }),
    card('plain', 'Plain', { at: at(3) }),
  ];

  it('puts the current step first (the open step with the newest card), then the steps with cards, what is tied to no step, documents, commits, and one line each for the steps with no cards and the done steps', () => {
    const area = areaOf(planOf(4, 2, 2), cards, { docs: [doc('d1', 'Doc')], news: newsOf() });
    const rows = areaRows(area, { news: newsOf(), size: big });
    expect(rows.map((r) => r.id)).toEqual(['row:step:s0', 'row:step:s1', 'lane:board', 'lane:documents', 'lane:commits:api', 'row:more-steps', 'row:done']);
    expect(rows.map((r) => r.state)).toEqual(['current', 'open', 'plain', 'plain', 'plain', 'open', 'done']);
    expect(rows.find((r) => r.id === 'row:more-steps')!.groups!.map((g) => g.key)).toEqual(['s2', 's3']);
    const nodes = areaBoardLayout(area, { news: newsOf(), size: big });
    const order = [area.id, 'row:step:s0', 'row:step:s1', 'lane:board', 'lane:documents', 'lane:commits:api', 'row:more-steps', 'row:done'].map((id) => byId(nodes, id).position.y);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    expect(byId(nodes, 'row:more-steps').type).toBe('fold');
    expect(byId(nodes, 'row:done').type).toBe('fold');
  });

  it('is the step with the newest card, not the first open step, when this Area is the current one', () => {
    const rows = areaRows(areaOf(planOf(3, 0), [card('x', 'X', { step: 's2', at: at(9) }), card('y', 'Y', { step: 's0', at: at(2) })]), { size: big });
    expect(rows[0]!.id).toBe('row:step:s2');
    expect(rows[0]!.state).toBe('current');
    expect(rows[0]!.title).toBe('Now');
  });

  it('is the first open step when no open step has a card', () => {
    const rows = areaRows(areaOf(planOf(3, 0), [card('x', 'X')]), { size: big });
    expect(rows[0]!.id).toBe('row:step:s0');
    expect(rows[0]!.state).toBe('current');
  });

  it('says "Next step" and never "Current" in an Area that is not the current one', () => {
    const plan = planOf(2, 0);
    plan.checkpoints[0]!.done = false;
    plan.checkpoints[0]!.steps = [{ key: 'e1', text: 'Earlier step', done: false }, { key: 'e2', text: 'Another earlier step', done: false }];
    const areas = buildBoardAreas({ plan, board: { cards: [card('e', 'E', { area: 'checkpoint:earlier', step: 'e2' })], positions: {}, links: [] } as BoardView });
    const other = areas.find((a) => a.id === 'checkpoint:cp')!;
    expect(other.data.current).toBe(false);
    const rows = areaRows(other, { size: big });
    expect(rows.some((r) => r.state === 'current')).toBe(false);
    expect(rows[0]).toMatchObject({ kind: 'step', state: 'next', title: 'Next' });
    const nodes = areaBoardLayout(other, { size: big });
    expect(nodes.filter((n) => n.type === 'step').every((n) => (n as { data: { state: string } }).data.state !== 'current')).toBe(true);
    // and the Area that is current says so
    const current = areas.find((a) => a.id === 'checkpoint:earlier')!;
    expect(areaRows(current, { size: big })[0]).toMatchObject({ state: 'current', id: 'row:step:e2' });
  });

  it('shows pinned cards first, then the newest, and puts the cards of other or missing steps under "Not tied to a step"', () => {
    const area = areaOf(planOf(2, 0), [
      card('old-pinned', 'Old pinned', { step: 's0', at: at(1), pinned: true }), card('new', 'New', { step: 's0', at: at(8) }), card('mid', 'Mid', { step: 's0', at: at(4) }),
      card('d', 'Dangling', { step: 'nope' }), card('l', 'Loose'),
    ]);
    const rows = areaRows(area, { size: big });
    expect(rows[0]!.items.map((i) => i.id)).toEqual(['old-pinned', 'new', 'mid']);
    expect(rows.find((r) => r.id === 'lane:board')!.items.map((i) => i.id).sort()).toEqual(['d', 'l']);
    const nodes = areaBoardLayout(area, { size: big });
    expect(byId(nodes, 'old-pinned').position.x).toBeLessThan(byId(nodes, 'new').position.x);
  });

  it('has only documents, commits and loose cards in an Area with no plan steps, and no waiting frame', () => {
    const area = buildBoardAreas({ board: { cards: [card('w', 'W', { area: undefined })], positions: {}, links: [] } as BoardView, documents: [doc('wd', 'Work doc')] })[0]!;
    expect(area.id).toBe('area:work');
    expect(areaRows(area, { size: big }).map((r) => r.id)).toEqual(['lane:board', 'lane:documents']);
    expect(areaBoardLayout(area, { size: big }).some((n) => n.type === 'checkpoint')).toBe(false);
  });
});

describe('areaBoardLayout v2: width', () => {
  const many = Array.from({ length: 9 }, (_, i) => card(`m${i}`, `Many ${i}`, { step: 's0', at: at(1 + i) }));
  const area = () => areaOf(planOf(2, 0), many);

  it('ends a row that has more than fits with a "+N more" button, and opening the row shows them all', () => {
    const size = { width: 1100, height: 400 };
    const closed = areaBoardLayout(area(), { size });
    const shown = closed.filter((n) => n.id.startsWith('m')).length;
    const more = byId(closed, 'row:step:s0:more') as BoardNode & { data: { count: number; holds: string[] } };
    expect(more.type).toBe('more');
    expect(shown).toBeGreaterThan(0);
    expect(shown + more.data.count).toBe(9);
    expect(more.data.holds).toHaveLength(more.data.count);
    const open = areaLayout(area(), { size: { width: 1100, height: 1400 }, openRow: 'row:step:s0' });
    expect(open.nodes.filter((n) => n.id.startsWith('m'))).toHaveLength(9);
    expect(open.nodes.some((n) => n.id.endsWith(':more'))).toBe(false);
  });

  it('puts every row\'s things under its header, in lines across the whole width, one to a line on a narrow canvas', () => {
    expect(areaStage({ width: 1100, height: 800 }).columns).toBe(3);
    const narrow = areaStage({ width: 420, height: 800 });
    expect(narrow.columns).toBe(1);
    const nodes = areaBoardLayout(area(), { size: { width: 420, height: 800 } });
    const head = byId(nodes, 'row:step:s0');
    expect(head.width).toBeGreaterThanOrEqual(narrow.width - ROW_SIZE.more - ROW_SIZE.gap);
    const first = byId(nodes, 'm8');
    expect(first.position.y).toBeGreaterThan(head.position.y);
    expect(first.position.x).toBe(0);
    for (const rect of nodeRects(nodes).values()) expect(rect.x + rect.width).toBeLessThanOrEqual(narrow.width);
  });
});

describe('areaBoardLayout v2: height', () => {
  const plan = planOf(4, 3, 2);
  const cards = [
    ...Array.from({ length: 3 }, (_, i) => file(`f${i}`, `File ${i}`, { step: 's0', at: at(10 + i) })),
    file('t1', 'Tied one', { step: 's1', at: at(4) }),
    file('l1', 'Loose one'), file('l2', 'Loose two'),
  ];
  const area = () => areaOf(plan, cards, { docs: [doc('d1', 'Doc'), doc('d2', 'Doc two')], news: newsOf(2) });
  const folded = (nodes: BoardNode[]) => new Set(nodes.filter((n) => n.type === 'fold').map((n) => n.id));

  it('folds commits first, then documents, then what is tied to no step, then the steps from the bottom, and never the waiting frame, the current step or the two lines of steps', () => {
    for (let height = 1500; height >= 560; height -= 20) {
      const nodes = areaBoardLayout(area(), { news: newsOf(2), size: { width: 1280, height } });
      const gone = folded(nodes);
      const isFolded = (id: string) => gone.has(id);
      // lower priority first: a row is folded whenever one that goes after it is
      expect(!isFolded('lane:documents') || ['lane:commits:api', 'lane:commits:repo1'].every(isFolded), `docs at ${height}`).toBe(true);
      expect(!isFolded('lane:board') || (isFolded('lane:documents') && isFolded('lane:commits:api')), `loose at ${height}`).toBe(true);
      expect(!isFolded('row:step:s1') || isFolded('lane:board'), `step at ${height}`).toBe(true);
      // The waiting frame is folded only as the last resort, and then the cards of the rows are drawn: that is why it was folded
      const waitingNode = byId(nodes, area().id) as BoardNode & { data: { title?: string; note?: string } };
      if (waitingNode.type === 'fold') {
        expect(waitingNode.data.title, `waiting fold at ${height}`).toBe('Waits for you');
        expect(waitingNode.data.note, `waiting fold at ${height}`).toBeTruthy();
        expect(nodes.some((n) => n.type === 'note' || n.type === 'file'), `cards at ${height}`).toBe(true);
      } else expect(waitingNode.type).toBe('checkpoint');
      expect(byId(nodes, 'row:step:s0').type).toBe('step');
      expect(byId(nodes, 'row:more-steps').type).toBe('fold');
      expect(byId(nodes, 'row:done').type).toBe('fold');
      for (const node of nodes) expect(node.id === 'x').toBe(false);
    }
    // and at some height each of them is folded: the order is tested, not only allowed
    const sawFolded = new Set<string>();
    for (let height = 1500; height >= 560; height -= 20) folded(areaBoardLayout(area(), { news: newsOf(2), size: { width: 1280, height } })).forEach((id) => sawFolded.add(id));
    for (const id of ['lane:commits:api', 'lane:documents', 'lane:board', 'row:step:s1']) expect(sawFolded.has(id), id).toBe(true);
  });

  it('shows the waiting decisions compactly, and a "+N more" that opens the rest whenever some are not shown', () => {
    const withThree = areaOf(planOf(2, 0, 3), []);
    expect(areaRowIds(withThree, { size: big })).toContain('row:waiting');
    const closed = byId(areaBoardLayout(withThree, { size: big }), withThree.id) as BoardNode & { data: { waiting: unknown[]; moreWaiting: number; waitingExpanded: boolean } };
    expect(closed.data.waiting).toHaveLength(2);
    expect(closed.data.moreWaiting).toBe(1);
    const open = byId(areaBoardLayout(withThree, { size: big, openRow: 'row:waiting' }), withThree.id) as typeof closed;
    expect(open.type).toBe('checkpoint');
    expect(open.data.waiting).toHaveLength(3);
    expect(open.data.waitingExpanded).toBe(true);
    // with two, a small canvas shows one and the rest is behind the same button
    const withTwo = areaOf(planOf(2, 0, 2), []);
    expect(areaRowIds(withTwo, { size: big })).toContain('row:waiting');
    const small = byId(areaBoardLayout(withTwo, { size: { width: 400, height: 560 } }), withTwo.id) as typeof closed;
    expect(small.data.waiting.length + small.data.moreWaiting).toBe(2);
    expect(areaRowIds(areaOf(planOf(2, 0, 1), []), { size: big })).not.toContain('row:waiting');
  });

  it('opens one row to take the room that is left and folds the others to one line, the waiting decisions first, keeping the current step', () => {
    const nodes = areaBoardLayout(area(), { news: newsOf(2), size: { width: 1280, height: 800 }, openRow: 'lane:board' });
    expect(byId(nodes, 'lane:board')).toMatchObject({ type: 'step', data: { expanded: true } });
    expect(byId(nodes, 'row:step:s0').type).toBe('step');
    expect((byId(nodes, 'row:step:s0') as BoardNode & { data: { expanded: boolean } }).data.expanded).toBe(false);
    // the waiting frame is one line while another row is open, and a press on it opens it
    expect(byId(nodes, area().id)).toMatchObject({ type: 'fold', data: { rowId: 'row:waiting' } });
    for (const id of ['row:step:s1', 'lane:documents', 'lane:commits:api', 'row:more-steps', 'row:done']) expect(byId(nodes, id).type, id).toBe('fold');
    expect(ids(nodes).has('l2')).toBe(true);
  });

  it('opens the current step itself, folding every other row', () => {
    const nodes = areaBoardLayout(area(), { news: newsOf(2), size: { width: 1280, height: 800 }, openRow: 'row:step:s0' });
    expect((byId(nodes, 'row:step:s0') as BoardNode & { data: { expanded: boolean } }).data.expanded).toBe(true);
    expect(byId(nodes, 'row:step:s1').type).toBe('fold');
  });

  it('opens the line of done steps as sub-rows: a step with cards heads its cards, the steps with none are listed', () => {
    const doneCards = [card('dc1', 'On done 1', { step: 'd1' }), card('dc2', 'On done 1 too', { step: 'd1', at: at(3) })];
    const a = areaOf(planOf(2, 3), doneCards);
    const nodes = areaBoardLayout(a, { size: big, openRow: 'row:done' });
    expect(nodes.filter((n) => n.id.startsWith('row:done:step:')).map((n) => n.id)).toEqual(['row:done:step:d0', 'row:done:step:d1', 'row:done:step:d2']);
    const lead = byId(nodes, 'row:done:step:d1');
    expect(byId(nodes, 'dc2').position.y).toBe(lead.position.y);
    expect(byId(nodes, 'dc2').position.x).toBeGreaterThan(lead.position.x);
    expect(byId(nodes, 'row:done:step:d0').position.y).toBeLessThan(lead.position.y);
    expect(areaRowOf(a, { size: big }, 'dc1')).toBe('row:done');
  });

  it('pages an opened row that does not fit, with the newest first and a page nobody has to scroll to, and every card is on some page', () => {
    const lots = Array.from({ length: 30 }, (_, i) => file(`p${i}`, `Page card ${i}`, { at: at(1 + i) }));
    const a = areaOf(planOf(2, 0), lots, { docs: [doc('d1', 'Doc')] });
    const size = { width: 1100, height: 700 };
    const first = areaLayout(a, { size, openRow: 'lane:board', page: 0 });
    expect(first.open!.pages).toBeGreaterThan(1);
    const pager = byId(first.nodes, 'lane:board:pager') as BoardNode & { data: { from: number; to: number; total: number; page: number } };
    expect(pager.type).toBe('pager');
    expect(pager.data).toMatchObject({ from: 1, total: 30, page: 0 });
    const seen = new Set<string>();
    let expectedFrom = 1;
    for (let page = 0; page < first.open!.pages; page += 1) {
      const result = areaLayout(a, { size, openRow: 'lane:board', page });
      const p = byId(result.nodes, 'lane:board:pager') as typeof pager;
      expect(p.data.from).toBe(expectedFrom);
      expectedFrom = p.data.to + 1;
      for (const n of result.nodes) if (n.id.startsWith('p')) seen.add(n.id);
      for (const [, rect] of nodeRects(result.nodes)) expect(rect.y + rect.height).toBeLessThanOrEqual(areaStage(size).height);
    }
    expect(seen.size).toBe(30);
    // the oldest is on the last page, and a jump to it says which
    expect(areaPlace(a, { size }, 'p0')).toEqual({ row: 'lane:board', page: first.open!.pages - 1 });
    expect(areaPlace(a, { size }, 'p29')!.page).toBe(0);
    // a page past the end is the last page
    expect(areaLayout(a, { size, openRow: 'lane:board', page: 99 }).open!.page).toBe(first.open!.pages - 1);
  });

  it('draws no static "not shown" tile: every thing of an open row is on a page', () => {
    const lots = Array.from({ length: 30 }, (_, i) => file(`q${i}`, `Q ${i}`, { at: at(1 + (i % 28)) }));
    const a = areaOf(planOf(2, 0), lots);
    for (const size of [{ width: 400, height: 560 }, { width: 886, height: 606 }, { width: 1280, height: 800 }]) {
      const ids0 = areaLayout(a, { size, openRow: 'lane:board' });
      const seen = new Set<string>();
      for (let page = 0; page < ids0.open!.pages; page += 1) areaLayout(a, { size, openRow: 'lane:board', page }).nodes.forEach((n) => seen.add(n.id));
      expect([...seen].filter((id) => id.startsWith('q'))).toHaveLength(30);
      expect([...seen].some((id) => id.includes('not shown'))).toBe(false);
    }
  });

  it('lets go of a row that is not there', () => {
    expect(areaBoardLayout(area(), { news: newsOf(2), size: big, openRow: 'row:nope' })).toEqual(areaBoardLayout(area(), { news: newsOf(2), size: big }));
    expect(areaRowIds(area(), { news: newsOf(2), size: big })).toContain('lane:board');
    expect(areaRowIds(area(), { news: newsOf(2), size: big })).not.toContain('row:nope');
  });

  it('marks document cards fresh when document is in news', () => {
    const freshNews: WhatsNewView = {
      reader: 'user',
      at: '2026-10-24T12:00:00Z',
      from: '2026-10-24T10:00:00Z',
      basis: 'last-look',
      empty: false,
      plan: { items: [], more: 0 },
      documents: { items: [{ name: 'Doc', kind: 'markdown', change: 'changed', at: '2026-10-24T11:45:00Z' }], more: 0 },
      knowledge: { items: [], more: 0 },
      problems: [],
      commits: [],
    };
    const area = areaOf(planOf(4, 2, 2), [], { docs: [doc('d1', 'Doc')], news: freshNews });
    const nodes = areaBoardLayout(area, { news: freshNews, size: big, openRow: 'lane:documents' });
    const docNode = nodes.find((n) => n.type === 'document');
    expect(docNode).toBeDefined();
    expect((docNode!.data as any).fresh).toBe(true);
  });

  it('keeps the view fixed at the readable zoom, with the rows starting at the top left', () => {
    expect(areaView()).toEqual({ x: ROW_SIZE.padX, y: ROW_SIZE.top, zoom: READABLE_ZOOM });
    expect(READABLE_ZOOM).toBeGreaterThanOrEqual(0.9);
    // that every text drawn at that zoom is at least 11 px is checked in the browser (e2e/board.spec.ts)
    // and every canvas of at least 400 px holds a card across
    expect(areaStage({ width: 400, height: 560 }).width).toBeGreaterThanOrEqual(ROW_SIZE.card);
  });
});

describe('areaBoardLayout v2: the real Area of this workspace', () => {
  // 13 open steps, 12 done, 10 cards with no step, a repository with commits and two waiting decisions
  const plan = planOf(13, 12, 2);
  const cards = [file('p1', 'Picture 1'), ...Array.from({ length: 9 }, (_, i) => file(`p${i + 2}`, `Picture ${i + 2}`, { at: at(2 + i) }))];
  const area = () => areaOf(plan, cards, { news: newsOf(1, 5) });
  const probes = [{ width: 1100, height: 700 }, { width: 886, height: 606 }, { width: 1046, height: 706 }, { width: 420, height: 800 }];

  it('draws the current step and cards, nothing under the bottom edge, and one line each for the rest', () => {
    for (const size of probes) {
      const stage = areaStage(size);
      const { nodes } = areaLayout(area(), { news: newsOf(1, 5), size });
      expect(byId(nodes, 'row:step:s0').type, `${size.width}`).toBe('step');
      // At least some cards stand on the screen, where the old layout folded them all
      expect(nodes.filter((n) => n.type === 'file').length, `${size.width}x${size.height}`).toBeGreaterThan(0);
      for (const [, rect] of nodeRects(nodes)) expect(rect.y + rect.height).toBeLessThanOrEqual(stage.height);
      expect(byId(nodes, 'row:more-steps').type).toBe('fold');
      expect(byId(nodes, 'row:done').type).toBe('fold');
    }
  });
});

describe('areaBoardLayout v2: the space is filled', () => {
  // The real board: 13 open steps, 12 done, 10 cards tied to no step, a repository with commits, two decisions that wait
  const plan = planOf(13, 12, 2);
  const cards = [file('p1', 'Picture 1'), ...Array.from({ length: 9 }, (_, i) => file(`p${i + 2}`, `Picture ${i + 2}`, { at: at(2 + i) }))];
  const area = () => areaOf(plan, cards, { news: newsOf(1, 5) });
  const drawn = (size: { width: number; height: number }) => areaBoardLayout(area(), { news: newsOf(1, 5), size }).filter((n) => n.type === 'file').length;

  it('shows at least 2 pictures on the canvas the Board gets at 1280x800 with the index open (678x574; 4 at 678x606), 2 in the narrow pane, and most of them on a big screen', () => {
    expect(drawn({ width: 678, height: 574 })).toBeGreaterThanOrEqual(2);
    expect(drawn({ width: 678, height: 606 })).toBeGreaterThanOrEqual(4);
    expect(drawn({ width: 414, height: 640 })).toBeGreaterThanOrEqual(2);
    expect(drawn({ width: 1480, height: 880 })).toBeGreaterThanOrEqual(7);
  });

  it('gives the current step a header that says the whole step, even when nothing is on it', () => {
    const nodes = areaBoardLayout(area(), { news: newsOf(1, 5), size: { width: 678, height: 574 } });
    const head = byId(nodes, 'row:step:s0') as BoardNode & { height: number; data: { text: string; prominent: boolean; empty: boolean; state: string } };
    expect(head.data).toMatchObject({ prominent: true, empty: true, state: 'current', text: 'Open step 0 with some words' });
    expect(head.height).toBe(ROW_SIZE.current);
    expect(head.width).toBeGreaterThan(400);
  });
});

describe('areaBoardLayout v2: an opened row is never poorer than the closed one', () => {
  const plan = planOf(6, 2, 3);
  const cards = [
    ...Array.from({ length: 8 }, (_, i) => file(`a${i}`, `Picture ${i}`, { step: 's0', at: at(2 + i) })),
    ...Array.from({ length: 8 }, (_, i) => card(`n${i}`, `Note ${i}`, { at: at(2 + i) })),
  ];
  const area = () => areaOf(plan, cards, { docs: [doc('d1', 'Doc 1'), doc('d2', 'Doc 2')], news: newsOf(1, 5) });
  const shownOf = (nodes: BoardNode[], itemIds: Set<string>) => nodes.filter((n) => itemIds.has(n.id)).length;

  it('shows at least as many things of the row on its page as the closed view shows of it', () => {
    for (const size of [{ width: 1100, height: 700 }, { width: 480, height: 800 }, { width: 678, height: 574 }]) {
      const rows = areaRows(area(), { news: newsOf(1, 5), size });
      const closed = areaBoardLayout(area(), { news: newsOf(1, 5), size });
      for (const row of rows) {
        const itemIds = new Set(row.items.map((item) => item.id));
        if (itemIds.size === 0) continue;
        const opened = areaBoardLayout(area(), { news: newsOf(1, 5), size, openRow: row.id });
        expect(shownOf(opened, itemIds), `${size.width}x${size.height} ${row.id}`).toBeGreaterThanOrEqual(shownOf(closed, itemIds));
      }
    }
  });
});

describe('areaBoardLayout v2: nothing overlaps, everything fits and everything can be reached', () => {
  const random = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const sizes = [
    { width: 400, height: 560 }, { width: 460, height: 700 }, { width: 520, height: 600 }, { width: 700, height: 640 }, { width: 886, height: 606 },
    { width: 1100, height: 700 }, { width: 1280, height: 800 }, { width: 1600, height: 1000 },
  ];

  it('holds for generated Areas from 400x560 up to 1600x1000, in the default layout, with each row open and on each of its pages', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = random(seed);
      const pick = (max: number) => Math.floor(rand() * (max + 1));
      const open = pick(15);
      const done = pick(15);
      const plan = planOf(open, done, pick(3));
      const cards: BoardCard[] = Array.from({ length: pick(20) }, (_, i) => {
        const where = rand();
        const key = where < 0.25 ? undefined : where < 0.35 ? 'dangling' : rand() < 0.4 && done > 0 ? `d${pick(done - 1)}` : open > 0 ? `s${pick(open - 1)}` : undefined;
        const extra = { title: `Card ${i} ${'a long title '.repeat(pick(8))}`, ...(key ? { step: key } : {}), pinned: rand() < 0.15, at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` };
        return rand() < 0.5 ? card(`c${i}`, 'x', extra) : file(`c${i}`, 'x', extra);
      });
      const news = newsOf(pick(2), 1 + pick(11));
      const docs = Array.from({ length: pick(3) }, (_, i) => doc(`doc${i}`, `Document ${i}`));
      const area = areaOf(plan, cards, { docs, news });
      const everything = [...area.cards.map((c) => c.id), ...area.documents.map((d) => `document:${d.id}`), ...area.repos.flatMap((r) => r.cards.map((c) => c.id))];
      for (const size of sizes) {
        const stage = areaStage(size);
        const where = `seed ${seed} ${size.width}x${size.height}`;
        const states: Array<{ row: string | null; page: number }> = [{ row: null, page: 0 }];
        for (const row of areaRowIds(area, { news, size })) {
          const first = areaLayout(area, { news, size, openRow: row, page: 0 });
          for (let page = 0; page < (first.open?.pages ?? 1); page += 1) states.push({ row, page });
        }
        const reached = new Set<string>();
        for (const state of states) {
          const { nodes } = areaLayout(area, { news, size, openRow: state.row, page: state.page });
          const rects = [...nodeRects(nodes).entries()];
          for (const [id, rect] of rects) {
            expect(rect.x, `${where} ${state.row}/${state.page} ${id} left`).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.width, `${where} ${state.row}/${state.page} ${id} right`).toBeLessThanOrEqual(Math.max(stage.width, 272));
            expect((rect.y + rect.height) * READABLE_ZOOM, `${where} ${state.row}/${state.page} ${id} bottom`).toBeLessThanOrEqual(size.height - ROW_SIZE.top - ROW_SIZE.bottom + 0.5);
          }
          for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
            // The buttons that page through the waiting decisions stand on the header line of their frame, inside it
            if ([rects[i]![0], rects[j]![0]].includes(`${WAITING_ROW}:pager`) && [rects[i]![0], rects[j]![0]].includes(area.id)) continue;
            expect(overlap(rects[i]![1], rects[j]![1]), `${where} ${state.row}/${state.page}: ${rects[i]![0]} vs ${rects[j]![0]}`).toBe(false);
          }
          for (const n of nodes) {
            reached.add(n.id);
            // A thing is never drawn smaller, or taller, than its compact variant is
            if (n.type === 'note' || n.type === 'file' || n.type === 'document' || n.type === 'commit' || n.type === 'placeholder' || (n.type === 'step' && (n.data as { static?: boolean }).static)) {
              expect(n.height, `${where} ${state.row}/${state.page}: ${n.id} is ${n.type}`).toBe(ITEM_HEIGHT[n.type === 'step' ? 'step' : n.type]);
              expect(n.width, `${where}: ${n.id} fills its column`).toBe(areaStage(size).cardWidth);
              expect(n.width).toBeGreaterThanOrEqual(ROW_SIZE.card);
              expect(n.width).toBeLessThanOrEqual(ROW_SIZE.maxCard);
            }
          }
        }
        for (const id of everything) {
          expect(reached.has(id), `${where}: ${id} is drawn in no state`).toBe(true);
          expect(areaPlace(area, { news, size }, id), `${where}: ${id} has no place`).not.toBeNull();
        }
      }
    }
  }, 60_000);
});

describe('lines to things that are not drawn', () => {
  it('go to the folded row or the "+N more" button that holds them, and say so in words', () => {
    const cards = [
      ...Array.from({ length: 9 }, (_, i) => card(`m${i}`, `Many ${i}`, { step: 's0', at: at(1 + i) })),
      card('a', 'Loose a'), card('b', 'Loose b'), card('c', 'Loose c'), card('shown', 'Shown', { step: 's0', at: at(20) }),
    ];
    const area = areaOf(planOf(2, 0), cards, { docs: [doc('d1', 'Doc')] });
    // The tallest canvas on which what is tied to no step is folded
    let nodes: BoardNode[] = [];
    for (let height = 900; height >= 300; height -= 10) {
      nodes = areaBoardLayout(area, { size: { width: 1100, height } });
      if (nodes.some((n) => n.id === 'lane:board' && n.type === 'fold')) break;
    }
    const folded = nodes.find((n) => n.id === 'lane:board' && n.type === 'fold');
    const more = nodes.find((n) => n.id === 'row:step:s0:more');
    expect(folded && more).toBeTruthy();
    const edges = boardEdges(nodes, [
      { id: 'l1', from: 'shown', to: 'a', by: 'u', at: at(1) },
      { id: 'l2', from: 'shown', to: 'm0', label: 'see', by: 'u', at: at(1) },
    ]);
    expect(edges.map((e) => e.target).sort()).toEqual(['lane:board', 'row:step:s0:more']);
    const labels = edges.map((e) => e.ariaLabel as string);
    expect(labels.some((l) => /^Link from Shown to Not tied to a step \(3 more\)$/.test(l))).toBe(true);
    expect(labels.some((l) => /^Link from Shown to Open step 0 with some words \(\d+ more\): see$/.test(l))).toBe(true);
  });

  it('go to the page buttons when the card is on another page of the opened row', () => {
    const lots = Array.from({ length: 30 }, (_, i) => file(`p${i}`, `Page card ${i}`, { at: at(1 + i) }));
    const area = areaOf(planOf(2, 0), [...lots, card('elsewhere', 'Elsewhere', { step: 's0', at: at(30) })]);
    const size = { width: 1100, height: 700 };
    const nodes = areaBoardLayout(area, { size, openRow: 'lane:board' });
    const pager = nodes.find((n) => n.type === 'pager') as BoardNode & { data: { holds: string[] } };
    expect(pager.data.holds.length).toBeGreaterThan(0);
    const hiddenId = pager.data.holds[0]!;
    expect(nodes.some((n) => n.id === hiddenId)).toBe(false);
    const edges = boardEdges(nodes, [{ id: 'l', from: 'elsewhere', to: hiddenId, by: 'u', at: at(1) }]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe('lane:board:pager');
    expect(edges[0]!.ariaLabel).toMatch(/^Link from Elsewhere to Not tied to a step \(\d+ more\)$/);
  });
});

describe('areaBoardLayout v2: the opened row, on the canvases the app really has', () => {
  // 706x474 is the 1100x700 window, 414x510 and 678x574 the narrow panes beside the chat, 886x574 a wide pane
  const sizes = [{ width: 706, height: 474 }, { width: 414, height: 510 }, { width: 678, height: 574 }, { width: 886, height: 574 }];
  const cards = [
    ...Array.from({ length: 12 }, (_, i) => file(`loose${i}`, `Loose picture ${i}`, { at: at(1 + i) })),
    ...Array.from({ length: 6 }, (_, i) => card(`now${i}`, `On the current step ${i}`, { step: 's0', at: at(10 + i) })),
    card('later', 'On a later step', { step: 's1', at: at(2) }),
  ];
  // An Area whose cards are tied to no step, so that row has the room, and one with a current step with cards and more rows under it
  const looseOnly = () => areaOf(planOf(1, 0), cards.slice(0, 12), { news: newsOf(1, 4) });
  const area = () => areaOf(planOf(2, 3, 1), cards, { docs: [doc('d1', 'Doc 1'), doc('d2', 'Doc 2'), doc('d3', 'Doc 3')], news: newsOf(1, 4) });

  it('never shows fewer things on a page than the row shows closed', () => {
    let compared = 0;
    for (const [size, a] of sizes.flatMap((size) => [area, looseOnly].map((make) => [size, make()] as const))) {
      const closed = areaBoardLayout(a, { size, news: newsOf(1, 4) });
      for (const row of areaRows(a, { size, news: newsOf(1, 4) })) {
        const itemIds = new Set(row.items.map((item) => item.id));
        const shown = closed.filter((n) => itemIds.has(n.id)).length;
        if (shown === 0) continue;
        const open = areaLayout(a, { size, news: newsOf(1, 4), openRow: row.id, page: 0 });
        const onPage = open.nodes.filter((n) => itemIds.has(n.id)).length;
        expect(onPage, `${row.id} at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(shown);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(8);
  });

  it('puts the page buttons and "+N more" on the line of the row\'s header, not in a line of their own', () => {
    const size = sizes[0]!;
    const a = area();
    const closed = areaBoardLayout(a, { size, news: newsOf(1, 4) });
    const more = closed.find((n) => n.type === 'more')!;
    const moreHead = byId(closed, more.id.replace(/:more$/, ''));
    expect(more.position.y + more.height / 2).toBeCloseTo(moreHead.position.y + moreHead.height / 2);
    expect(moreHead.position.x + moreHead.width).toBeLessThanOrEqual(more.position.x);
    const open = areaLayout(a, { size, news: newsOf(1, 4), openRow: 'lane:board', page: 0 });
    const pager = open.nodes.find((n) => n.type === 'pager')!;
    const head = byId(open.nodes, 'lane:board');
    expect(pager.position.y + pager.height / 2).toBeCloseTo(head.position.y + head.height / 2);
    expect(head.position.x + head.width).toBeLessThanOrEqual(pager.position.x);
    expect(pager.position.x + pager.width).toBeLessThanOrEqual(areaStage(size).width);
    // no card shares the pager's line
    for (const n of open.nodes) if (n.type === 'file') expect(n.position.y).toBeGreaterThanOrEqual(head.position.y + head.height);
  });
});

describe('areaStage: things fill the line', () => {
  it('stretches the columns to the width of the line, between the least and the most a thing is drawn at', () => {
    for (const width of [414, 520, 706, 886, 1100, 1600, 1920]) {
      const stage = areaStage({ width, height: 700 });
      expect(stage.cardWidth).toBeGreaterThanOrEqual(ROW_SIZE.card);
      expect(stage.cardWidth).toBeLessThanOrEqual(ROW_SIZE.maxCard);
      const used = stage.columns * stage.cardWidth + (stage.columns - 1) * ROW_SIZE.gap;
      expect(used).toBeLessThanOrEqual(stage.width);
      // Without the cap, nothing is left over but the rounding
      if (stage.cardWidth < ROW_SIZE.maxCard) expect(stage.width - used).toBeLessThan(stage.columns);
    }
  });

  it('puts the buttons of the header line right after the header, so the keyboard reaches them before the things', () => {
    const size = { width: 706, height: 474 };
    const a = areaOf(planOf(2, 3, 1), Array.from({ length: 30 }, (_, i) => file(`tab${i}`, `Tab ${i}`, { at: at(1 + i), step: 's0' })), { news: newsOf(1, 4) });
    const closed = areaBoardLayout(a, { size, news: newsOf(1, 4) });
    const more = closed.find((n) => n.type === 'more')!;
    const pos = closed.findIndex((n) => n.id === more.id);
    expect(closed[pos - 1]!.id).toBe(more.id.replace(/:more$/, ''));
    const open = areaLayout(a, { size, news: newsOf(1, 4), openRow: 'row:step:s0', page: 0 }).nodes;
    const pagerAt = open.findIndex((n) => n.type === 'pager');
    expect(pagerAt).toBeGreaterThan(0);
    expect(open[pagerAt - 1]!.id).toBe('row:step:s0');
  });
});

describe('answersThatFit: the answers that are whole buttons on the one line of a waiting decision', () => {
  const four = ['Stay removed; the Board takes over', 'Bring back Code (uncommitted changes)', 'Bring back Code and Services', 'Bring back all three'];

  it('takes as many answers as fit whole, in order, and calls the ghost button "All answers…" when some did not', () => {
    const wide = answersThatFit(four, ROW_SIZE.decisionWidth);
    expect(wide.shown).toEqual(four.slice(0, wide.shown.length));
    expect(wide.shown.length).toBeGreaterThan(0);
    expect(wide.shown.length).toBeLessThan(four.length);
    expect(wide.hidden).toBe(four.length - wide.shown.length);
    expect(wide.ghost).toBe('All answers…');
    const roomy = answersThatFit(['UTC', 'Local time (browser)', 'Account setting'], ROW_SIZE.decisionWidth);
    expect(roomy).toEqual({ shown: ['UTC', 'Local time (browser)', 'Account setting'], hidden: 0, ghost: 'Other answer…' });
  });

  it('shows fewer on a narrower card, never reorders, and never shows an answer that does not fit in what is left', () => {
    let last = Infinity;
    for (const width of [720, 600, 500, 420, 340, 300]) {
      const { shown } = answersThatFit(four, width);
      expect(shown.length, `${width}`).toBeLessThanOrEqual(last);
      expect(shown, `${width}`).toEqual(four.filter((answer) => shown.includes(answer)));
      last = shown.length;
    }
    expect(answersThatFit(['UTC', 'Local time (browser)', 'Account setting'], 300).shown.length).toBeLessThan(3);
  });

  it('leaves an answer that could not fit even alone for the dialog, and goes on with the shorter ones after it', () => {
    const long = 'Yes, and also rewrite every export so that it streams, with the old files kept for a year';
    const fit = answersThatFit([long, 'Yes', 'No'], 420);
    expect(fit.shown).toEqual(['Yes', 'No']);
    expect(fit.hidden).toBe(1);
    expect(fit.ghost).toBe('All answers…');
  });

  it('counts CJK and emoji letters as about 1 em wide and accented Latin letters as capitals, so that they do not run under the ghost button', () => {
    // 12 letters: ~120 px of Latin lower case, ~170 px of Japanese or emoji, which is more than is left of a 300 px card
    const latin = 'abcdefghijkl';
    const cjk = 'はいそうしてくださいおねがい';
    const emoji = '👍👍👍👍👍👍👍👍👍👍👍👍';
    expect(answersThatFit([latin], 300).shown).toEqual([latin]);
    expect(answersThatFit([cjk], 300).shown).toEqual([]);
    expect(answersThatFit([emoji], 300).shown).toEqual([]);
    // accented letters are wider than the plain ones: it takes a wider card to show the same words with accents
    const room = (text: string) => { let width = 200; while (answersThatFit([text], width).shown.length === 0 && width < 800) width += 4; return width; };
    expect(room('ménage à trois été')).toBeGreaterThan(room('menage a trois ete'));
    expect(room(cjk)).toBeGreaterThan(room(latin));
  });

  it('has no answers to show when there are no suggestions, and a ghost button for a free answer', () => {
    expect(answersThatFit([], 500)).toEqual({ shown: [], hidden: 0, ghost: 'Other answer…' });
  });
});

describe('areaBoardLayout: what the Now row is', () => {
  const step = (key: string, text: string, done = false, parent?: string) => ({ key, text, done, ...(parent ? { parent } : {}) });
  const planWith = (steps: ReturnType<typeof step>[]): PlanFileView => ({
    title: 'P', checkpoints: [{ key: 'cp', title: 'The checkpoint', done: false, steps, decisions: [] }], steps: [], decisions: [], waiting: [],
  });
  const rowsOf = (steps: ReturnType<typeof step>[], cards: BoardCard[] = []) => areaRows(areaOf(planWith(steps), cards), { size: big });

  it('is never a heading: a step with open steps under it', () => {
    const rows = rowsOf([step('h', '**Audit & Polish**:'), step('a', 'Slice A', false, 'h'), step('b', 'Slice B', false, 'h')]);
    expect(rows[0]).toMatchObject({ id: 'row:step:a', state: 'current', text: 'Slice A', heading: '**Audit & Polish**:' });
    expect(rows.find((r) => r.id === 'row:more-steps')!.groups!.map((g) => g.key)).toEqual(['h', 'b']);
  });

  it('is a real step when all the steps under it are done', () => {
    const rows = rowsOf([step('h', 'Heading with done children'), step('a', 'Done child', true, 'h'), step('z', 'Later step')]);
    expect(rows[0]).toMatchObject({ id: 'row:step:h', text: 'Heading with done children' });
    expect(rows[0]!.heading).toBeUndefined();
  });

  it('skips a heading nested two deep, and a heading under a heading, and names the nearest heading above', () => {
    const steps = [step('top', 'Top'), step('mid', 'Middle', false, 'top'), step('leaf', 'Leaf step', false, 'mid'), step('leaf2', 'Second leaf', false, 'mid')];
    expect([...headingKeys(steps)].sort()).toEqual(['mid', 'top']);
    const rows = rowsOf(steps);
    expect(rows[0]).toMatchObject({ id: 'row:step:leaf', heading: 'Middle' });
  });

  it('is still the leaf with the newest card, when the Area where only headings\' children are open is the current one', () => {
    const steps = [step('h', 'Heading'), step('a', 'Child A', false, 'h'), step('b', 'Child B', false, 'h')];
    const rows = rowsOf(steps, [card('x', 'X', { step: 'b', at: at(9) }), card('y', 'Y', { step: 'h', at: at(20) })]);
    expect(rows[0]).toMatchObject({ id: 'row:step:b', state: 'current' });
  });

  it('counts a heading as a step for the counts, and keeps it in the "more open steps" line', () => {
    const area = areaOf(planWith([step('h', 'Heading'), step('a', 'Child', false, 'h'), step('d', 'Done', true)]), []);
    expect(area.data.stepsTotal).toBe(3);
    expect(area.data.stepsDone).toBe(1);
  });
});

describe('areaBoardLayout: no raw markup in a step\'s words', () => {
  const marked = '**Slice C: Split mode** with `code` and [a link](https://x.test):';
  const plan: PlanFileView = {
    title: 'P', checkpoints: [{ key: 'cp', title: 'The checkpoint', done: false, steps: [
      { key: 'a', text: '**First** open step', done: false }, { key: 'b', text: marked, done: false }, { key: 'c', text: '_Third_ `step`', done: false }, { key: 'd', text: '**Done** one', done: true },
    ], decisions: [{ key: 'q', question: 'Is **this** what you want?', done: false, suggested: ['Yes'], checkpoint: 'cp' }] }],
    steps: [], decisions: [], waiting: ['q'],
  };

  it('says the plain words in the previews, the fold\'s title and the waiting fold\'s question', () => {
    const area = areaOf(plan, [file('f1', 'Picture', { step: 'a' }), file('f2', 'Picture 2')]);
    const nodes = areaBoardLayout(area, { size: { width: 700, height: 150 } });
    const folds = nodes.filter((n) => n.type === 'fold').map((n) => n.data);
    const text = JSON.stringify(folds);
    expect(text).not.toMatch(/\*\*|`|\]\(/);
    const more = nodes.find((n) => n.id === 'row:more-steps') as BoardNode & { data: { preview?: string } };
    expect(more.data.preview).toBe('Slice C: Split mode with code and a link · Third step');
    expect(text).toContain('Done one');
    // the waiting decisions on their one line say what the question is, in plain words
    const crowdedPlan = planOf(13, 12, 2);
    crowdedPlan.checkpoints[1]!.decisions[0]!.question = 'Is **this** what you want?';
    const crowded = areaOf(crowdedPlan, [file('p', 'Picture'), file('p2', 'Picture 2')], { news: newsOf(1, 3) });
    const waitingNode = byId(areaBoardLayout(crowded, { news: newsOf(1, 3), size: { width: 706, height: 474 } }), crowded.id) as BoardNode & { data: { note?: string } };
    expect(waitingNode.type).toBe('fold');
    expect(waitingNode.data.note).toBe('Is this what you want?');
  });
});

describe('the waiting frame', () => {
  const withQuestions = (count: number, check = false): BoardArea => {
    const plan = planOf(3, 0, count);
    if (check) plan.checkpoints[1]!.check = 'npm test';
    return areaOf(plan, [file('p', 'Picture', { step: 's0' }), file('q', 'Picture 2')]);
  };

  it('is as tall as the cards, the footer and the check that it draws, at every count', () => {
    for (const count of [1, 2, 3, 5]) for (const check of [false, true]) {
      const area = withQuestions(count, check);
      const node = byId(areaBoardLayout(area, { size: big }), area.id) as BoardNode & { height: number; width: number; data: { waiting: unknown[]; moreWaiting: number } };
      const shown = node.data.waiting.length;
      // the frame's 2 px border, its 32 px head, 90 px a card, 28 px for "+N more", 8 px of padding and 37 px for the check: constants, not the function
      const expected = 2 + 32 + shown * 90 + (count > shown ? 28 : 0) + 8 + (check ? 37 : 0);
      expect(node.height, `${count} ${check}`).toBe(expected);
      expect(waitingHeight(shown, count > shown, check), `${count} ${check}`).toBe(expected);
      expect(node.width).toBeLessThanOrEqual(ROW_SIZE.decisionWidth);
      expect(node.width).toBeGreaterThan(480);
    }
  });

  it('puts the waiting decisions in pages, with the buttons on the frame, when the opened decisions do not fit; never a scroll box', () => {
    const area = withQuestions(5);
    const size = { width: 700, height: 560 };
    const first = areaLayout(area, { size, openRow: WAITING_ROW, page: 0 });
    const frame = byId(first.nodes, area.id) as BoardNode & { height: number; data: { waiting: Array<{ key: string }>; waitingExpanded: boolean } };
    expect(frame.data.waitingExpanded).toBe(true);
    expect(frame.data.waiting.length).toBeLessThan(5);
    expect(first.open).toMatchObject({ rowId: WAITING_ROW, page: 0 });
    expect(first.open!.pages).toBeGreaterThan(1);
    expect(frame.height).toBeLessThanOrEqual(areaStage(size).height);
    const seen = new Set<string>();
    for (let page = 0; page < first.open!.pages; page += 1) {
      const { nodes } = areaLayout(area, { size, openRow: WAITING_ROW, page });
      expect(nodes.some((n) => n.id === `${WAITING_ROW}:pager`)).toBe(true);
      for (const [, rect] of nodeRects(nodes)) expect(rect.y + rect.height).toBeLessThanOrEqual(areaStage(size).height);
      (byId(nodes, area.id) as typeof frame).data.waiting.forEach((d) => seen.add(d.key));
    }
    expect([...seen].sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
  });

  it('shows at least one line of cards with two waiting decisions at the canvases of the laptop windows, folding the decisions to their line only when it must', () => {
    const area = withQuestions(2);
    const need = (size: { width: number; height: number }) => {
      const nodes = areaBoardLayout(area, { size });
      const waitingNode = byId(nodes, area.id);
      return { cards: nodes.filter((n) => n.type === 'file').length, waiting: waitingNode.type };
    };
    for (const size of [{ width: 706, height: 474 }, { width: 414, height: 510 }, { width: 678, height: 574 }, { width: 886, height: 606 }, { width: 1100, height: 700 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      expect(need(size).cards, `${size.width}x${size.height}`).toBeGreaterThan(0);
    }
    expect(need({ width: 1280, height: 800 }).waiting).toBe('checkpoint');
    expect(need({ width: 1440, height: 900 }).waiting).toBe('checkpoint');
  });

  it('can be opened from its one line when a single decision is folded, with its answers in the frame', () => {
    const plan = planOf(8, 0, 1);
    const area = areaOf(plan, Array.from({ length: 6 }, (_, i) => file(`f${i}`, `Pic ${i}`, { step: 's0', at: at(1 + i) })));
    const size = { width: 700, height: 330 };
    const closed = areaBoardLayout(area, { size });
    expect(byId(closed, area.id).type).toBe('fold');
    expect(areaRowIds(area, { size })).toContain(WAITING_ROW);
    const open = areaBoardLayout(area, { size, openRow: WAITING_ROW });
    expect(byId(open, area.id).type).toBe('checkpoint');
    expect((byId(open, area.id) as BoardNode & { data: { waiting: unknown[] } }).data.waiting).toHaveLength(1);
  });
});

describe('the waiting frame on a very low window', () => {
  const planWithCheck = (count: number) => planOf(4, 0, count);
  it('keeps every row on the stage at canvas heights down to 250, with one, two or five decisions, with and without cards: the decisions go to their one line', () => {
    for (const count of [1, 2, 5]) for (const withCards of [false, true]) for (const width of [414, 700]) for (let height = 250; height <= 500; height += 10) {
      const area = areaOf(planWithCheck(count), withCards ? [file('p', 'Picture', { step: 's0' }), file('q', 'Picture 2')] : []);
      const nodes = areaBoardLayout(area, { size: { width, height } });
      const stage = areaStage({ width, height });
      for (const [id, rect] of nodeRects(nodes)) expect(rect.y + rect.height, `${count} decisions, cards ${withCards}, ${width}x${height}: ${id}`).toBeLessThanOrEqual(stage.height);
    }
  });
});
