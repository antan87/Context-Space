import { describe, expect, it } from 'vitest';
import { changeText, forYou, itemLook, startableItems, workingOn, milestoneProgress, planNames, splitPlanCodes, stateLine, whenText, whoName, NEEDS_YOU_LOOK, STATUS_LOOK } from './planView.js';
import type { PlanItemView, PlanWords } from './planTypes.js';

const words: PlanWords = {
  statuses: {
    todo: { label: 'To do', meaning: '' }, in_progress: { label: 'In progress', meaning: '' }, blocked: { label: 'Blocked', meaning: '' },
    done: { label: 'Done', meaning: '' }, dropped: { label: 'Dropped', meaning: '' }, later: { label: 'Later', meaning: '' },
  },
  kinds: {} as PlanWords['kinds'],
  needsYou: { label: 'Needs you', meaning: '' },
  sections: [],
  rules: [],
  namesFirst: '',
  changes: { started: 'started', answered: 'answered' },
};

const item = (fields: Partial<PlanItemView>): PlanItemView => ({
  id: 'M1', label: 'M1 CSV export', kind: 'milestone', title: 'CSV export', status: 'todo', waitsFor: [], holdsUp: [], updatedAt: '2026-10-10T10:00:00.000Z', ...fields,
});

describe('whoName', () => {
  it('says You, the AI tool by name, or ContextSpace', () => {
    expect(whoName('user')).toBe('You');
    expect(whoName('agent')).toBe('The AI');
    expect(whoName('claude')).toBe('Claude');
    expect(whoName('contextspace')).toBe('ContextSpace');
    expect(whoName('PO')).toBe('PO');
  });
});

describe('stateLine', () => {
  it('says where an item is and what it carries, in the plan\'s words', () => {
    expect(stateLine(item({}), words)).toBe('To do · ready to start');
    expect(stateLine(item({ waitsFor: [{ id: 'Q1', label: 'Q1 Which zone?', status: 'todo' }, { id: 'T1', label: 'T1 Queue', status: 'done' }] }), words))
      .toBe('To do · starts after Q1 Which zone?');
    expect(stateLine(item({ status: 'in_progress', history: [{ at: '', by: 'user', action: 'added' }, { at: '', by: 'claude', action: 'started' }] }), words)).toBe('In progress · Claude');
    expect(stateLine(item({ status: 'blocked', blockedReason: 'Design is not ready' }), words)).toBe('Blocked · Design is not ready');
    expect(stateLine(item({ status: 'done', resolution: 'Passed its check' }), words)).toBe('Done · Passed its check');
    expect(stateLine(item({ status: 'later', revisitWhen: 'after release' }), words)).toBe('Later · look again after release');
    expect(stateLine(item({ kind: 'question', owner: 'user' }), words)).toBe('Waiting for your answer');
    expect(stateLine(item({ kind: 'question', owner: 'PO' }), words)).toBe('PO answers');
    expect(stateLine(item({ kind: 'question', owner: 'agent' }), words)).toBe('The AI answers');
    expect(stateLine(item({ kind: 'question', status: 'done', resolution: 'UTC' }), words)).toBe('Answered · UTC');
    expect(stateLine(item({ status: 'in_progress', proposal: { action: 'done', by: 'claude', note: 'Tests pass', at: '' } }), words)).toBe('Claude says it is done · Tests pass');
  });

  it('shows what waits for the user as Needs you, whatever its status', () => {
    expect(itemLook(item({ status: 'in_progress', proposal: { action: 'done', by: 'claude', note: '', at: '' } }))).toBe(NEEDS_YOU_LOOK);
    expect(itemLook(item({ kind: 'question', owner: 'user' }))).toBe(NEEDS_YOU_LOOK);
    expect(itemLook(item({ kind: 'question', owner: 'agent' }))).toBe(STATUS_LOOK.todo);
    expect(itemLook(item({ status: 'blocked' }))).toBe(STATUS_LOOK.blocked);
  });
});

describe('small helpers', () => {
  it('words a change and its time', () => {
    expect(changeText({ at: '', by: 'claude', action: 'started', itemId: 'M1', label: 'M1 CSV export' }, words)).toBe('started M1 CSV export');
    expect(changeText({ at: '', by: 'user', action: 'answered', itemId: 'Q1', label: 'Q1 Zone?', note: 'UTC' }, words)).toBe('answered Q1 Zone?: UTC');
    const now = new Date('2026-10-10T12:00:00.000Z');
    expect(whenText('2026-10-10T11:58:00.000Z', now)).toBe('2 min ago');
    expect(whenText('2026-10-10T09:00:00.000Z', now)).toBe('3 h ago');
    expect(whenText('2026-10-09T11:00:00.000Z', now)).toBe('yesterday');
    // A check carried over without its time was stored as the epoch: no "Jan 1".
    expect(whenText('1970-01-01T00:00:00.000Z', now)).toBe('');
    expect(whenText(undefined, now)).toBe('');
  });

  it('counts milestone progress without the dropped ones', () => {
    expect(milestoneProgress({ milestones: [item({ status: 'done' }), item({ status: 'in_progress' }), item({ status: 'dropped' })] })).toEqual({ done: 1, total: 2 });
  });
});

describe('forYou', () => {
  it('speaks to the user where the shared words speak about them', () => {
    expect(forYou("For the user's items, and for milestones, it asks: the user sees it under Needs you.")).toBe('For your items, and for milestones, it asks: you see it under Needs you.');
    expect(forYou("It collects what waits for the user's answer or OK.")).toBe('It collects what waits for your answer or OK.');
    expect(forYou('The user can act as themselves.')).toBe('You can act as themselves.');
    expect(forYou('A user story')).toBe('A user story');
  });
});

describe('splitPlanCodes', () => {
  const names = planNames({ needsYou: [], milestones: [item({ id: 'M2', title: 'CSV export endpoint' })], otherOpen: [item({ id: 'Q1', title: 'Which zone?' })], closed: [] });

  it('marks the codes the plan knows, and says when the name already follows', () => {
    expect(splitPlanCodes('Next is M2, and Q1 waits for you.', names)).toEqual([
      'Next is ', { id: 'M2', title: 'CSV export endpoint', named: false }, ', and ', { id: 'Q1', title: 'Which zone?', named: false }, ' waits for you.',
    ]);
    expect(splitPlanCodes('M2 CSV export endpoint is in progress', names)).toEqual([{ id: 'M2', title: 'CSV export endpoint', named: true }, ' CSV export endpoint is in progress']);
  });

  it('leaves codes it does not know, and parts of other words, alone', () => {
    expect(splitPlanCodes('M3 and M22 and xM2 and M2-b', names)).toEqual(['M3 and M22 and xM2 and M2-b']);
    expect(splitPlanCodes('nothing here', new Map())).toEqual(['nothing here']);
  });
});

describe('what a tool works on and what a session can start on', () => {
  const started = (by: string, at: string) => [{ at, by, action: 'started' }];
  const view = {
    milestones: [
      item({ id: 'M1', title: 'Query', status: 'done' }),
      item({ id: 'M2', title: 'Endpoint', status: 'in_progress', history: started('claude', '2026-10-10T10:00:00.000Z') }),
      item({ id: 'M3', title: 'Button', label: 'M3 Button' }),
    ],
    otherOpen: [item({ id: 'T1', kind: 'task', title: 'Queue', label: 'T1 Queue', status: 'in_progress', history: started('Claude', '2026-10-10T11:00:00.000Z') })],
    needsYou: [], closed: [], ready: ['M3 Button'],
  } as unknown as Parameters<typeof startableItems>[0];

  it('names the items a tool started, newest first', () => {
    expect(workingOn(view, 'claude').map((entry) => entry.id)).toEqual(['T1', 'M2']);
    expect(workingOn(view, 'codex')).toEqual([]);
    expect(workingOn(undefined, 'claude')).toEqual([]);
  });

  it('offers ready items first, then what is in progress', () => {
    expect(startableItems(view).map((entry) => entry.id)).toEqual(['M3', 'M2', 'T1']);
  });
});
