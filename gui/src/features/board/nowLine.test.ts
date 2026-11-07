import { describe, expect, it } from 'vitest';
import type { PlanFileView } from '../plan/planFile.js';
import { focusOf } from '../plan/focus.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import { buildBoardAreas } from './boardAreas.js';
import type { BoardView } from './boardData.js';
import { firstWaiting, newsLines, nowLineParts, nowLineTarget } from './nowLine.js';

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const plan = (now?: PlanFileView['now'], waiting = false): PlanFileView => ({
  title: 'P', file: 'PLAN.md', source: 'file', intro: '', sections: [], changes: [],
  checkpoints: [
    { key: 'one', title: 'First checkpoint', done: false, steps: [{ key: 'a', text: '**F1**: first step', done: false }, { key: 'b', text: 'Second step', done: false }], decisions: waiting ? [{ key: 'q', question: 'Which one?', done: false, suggested: ['A', 'B'] }] : [] },
    { key: 'two', title: 'Second checkpoint', done: false, steps: [{ key: 'c', text: 'F2: the Code window', done: false }], decisions: [] },
  ],
  steps: [], decisions: [], waiting: waiting ? ['q'] : [], ...(now !== undefined ? { now } : {}),
});
const board: BoardView = { cards: [], positions: {}, links: [] } as BoardView;
const news = (over: Partial<WhatsNewView> = {}): WhatsNewView => ({
  reader: 'user', at: iso(0), from: iso(60), basis: 'last-look', empty: false, problems: [],
  plan: { items: [], more: 0 }, documents: { items: [], more: 0 }, knowledge: { items: [], more: 0 }, commits: [], ...over,
});
const partsFor = (p: PlanFileView, n?: WhatsNewView) => {
  const areas = buildBoardAreas({ plan: p, board, news: n });
  return { areas, parts: nowLineParts({ focus: focusOf(p), areas, news: n }) };
};

describe('nowLineParts', () => {
  it('says Now with the step, its Area and who said it, when someone set it', () => {
    const { parts } = partsFor(plan({ key: 'c', by: 'claude', at: iso(5) }));
    expect(parts).toMatchObject({ word: 'Now', text: 'F2: the Code window', area: 'Second checkpoint', who: 'Claude · 5 min ago', waiting: 0, news: 0 });
  });

  it('says Next up for the plan order, with no one named, and the step without its markdown', () => {
    const { parts } = partsFor(plan(null));
    expect(parts).toMatchObject({ word: 'Next up', text: 'F1: first step', area: 'First checkpoint' });
    expect(parts.who).toBeUndefined();
  });

  it('counts the questions that wait and the news, and shows neither at zero', () => {
    const { parts } = partsFor(plan(null, true), news({ plan: { items: [{ at: iso(3), by: 'claude', action: 'added', kind: 'step', key: 'b', text: 'Second step' }], more: 0 }, commits: [{ repo: 'r', more: 2, commits: [] }] }));
    expect(parts).toMatchObject({ waiting: 1, news: 3 });
    expect(partsFor(plan(null), news({ empty: true })).parts).toMatchObject({ waiting: 0, news: 0 });
  });

  it('has no word when nothing is open', () => {
    const done = { ...plan(null), checkpoints: [] };
    expect(nowLineParts({ focus: focusOf(done), areas: [] })).toMatchObject({ word: null, text: '' });
  });
});

describe('where the parts go', () => {
  it('Now goes to the row of the step in the focus Area, and to the Area alone when it has no step', () => {
    const set = partsFor(plan({ key: 'c', by: 'claude', at: iso(1) }));
    expect(nowLineTarget(set.areas, focusOf(plan({ key: 'c', by: 'claude', at: iso(1) })))).toEqual({ areaId: 'checkpoint:two', nodeId: 'row:step:c' });
    const empty = { ...plan(null), checkpoints: [{ key: 'one', title: 'First', done: false, steps: [], decisions: [] }] };
    expect(nowLineTarget(buildBoardAreas({ plan: empty, board }), focusOf(empty))).toEqual({ areaId: 'checkpoint:one', nodeId: null });
  });

  it('the question goes to the first waiting decision as the Board index jumps to it', () => {
    const { areas } = partsFor(plan(null, true));
    expect(firstWaiting(areas)).toMatchObject({ category: 'waiting', areaId: 'checkpoint:one', title: 'Which one?' });
    expect(firstWaiting(partsFor(plan(null)).areas)).toBeNull();
  });

  it('news lines are the newest first, jump to the step or checkpoint they are about, and only show text where there is nothing to go to', () => {
    const view = news({
      plan: { items: [
        { at: iso(30), by: 'claude', action: 'added', kind: 'step', key: 'a', text: 'F1: first step' },
        { at: iso(10), by: 'claude', action: 'ticked', kind: 'checkpoint', key: 'two', text: 'Second checkpoint' },
        { at: iso(20), by: 'claude', action: 'removed', kind: 'step', key: 'gone', text: 'A removed step' },
      ], more: 0 },
      knowledge: { items: [{ id: 'k', title: 'A lesson', date: null, type: 'decision' }], more: 0 },
    });
    const areas = buildBoardAreas({ plan: plan(null), board, news: view });
    const lines = newsLines(view, areas);
    expect(lines.map((line) => line.text.split(' · ')[0])).toEqual(['claude ticked “Second checkpoint”'.replace('claude', 'Claude'), 'Claude removed “A removed step”', 'Claude added “F1: first step”', 'decision “A lesson”']);
    expect(lines[0]!.jump).toEqual({ areaId: 'checkpoint:two', nodeId: null });
    expect(lines[1]!.jump).toBeUndefined();
    expect(lines[2]!.jump).toEqual({ areaId: 'checkpoint:one', nodeId: 'row:step:a' });
    expect(lines[3]!.jump).toBeUndefined();
  });

  it('shows eight and says how many more there are', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ at: iso(i), by: 'claude', action: 'added' as const, kind: 'step' as const, key: 'b', text: `Step ${i}` }));
    const lines = newsLines(news({ plan: { items, more: 0 } }), buildBoardAreas({ plan: plan(null), board }));
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toEqual({ text: 'and 4 more' });
  });

  it('names an AI with no tool name "AI", and other tools by their name', () => {
    expect(partsFor(plan({ key: 'c', by: 'ai', at: iso(0) })).parts.who).toBe('AI · just now');
    expect(partsFor(plan({ key: 'c', by: 'codex', at: iso(0) })).parts.who).toBe('Codex · just now');
    expect(partsFor(plan({ key: 'c', by: 'user', at: iso(0) })).parts.who).toBe('You · just now');
  });
});
