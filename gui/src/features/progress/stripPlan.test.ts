import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '../../types.js';
import type { PlanChangeEntry, PlanItemView, PlanView } from '../plan/planTypes.js';
import { aiCloses, byAi, planQuestionFor, planQuestionsForYou, sameQuestion } from './stripPlan.js';

const item = (fields: Partial<PlanItemView> & Pick<PlanItemView, 'id' | 'title'>): PlanItemView => ({
  label: `${fields.id} ${fields.title}`, kind: 'question', status: 'todo', owner: 'user', waitsFor: [], holdsUp: [], updatedAt: '', ...fields,
});
const change = (fields: Partial<PlanChangeEntry> & Pick<PlanChangeEntry, 'itemId' | 'action' | 'by' | 'at'>): PlanChangeEntry => ({ label: fields.itemId, ...fields });
const view = (fields: Partial<PlanView>): PlanView => ({ needsYou: [], milestones: [], otherOpen: [], closed: [], changes: [], ...fields } as PlanView);
const chat = (message: string): OpenQuestion => ({ id: message, timestamp: '2026-10-15T10:00:00.000Z', harness: 'claude', message } as OpenQuestion);

describe('sameQuestion', () => {
  it('matches a chat question to its name in the plan, whole or cut short', () => {
    expect(sameQuestion('Which branch?', '  Which   branch? ')).toBe(true);
    expect(sameQuestion('Should the reader open tabs…', 'Should the reader open tabs or windows, and keep the scroll?')).toBe(true);
    expect(sameQuestion('Which branch?', 'Which branch should I use?')).toBe(false);
  });
});

describe('the questions in the strip', () => {
  const plan = view({ needsYou: [
    item({ id: 'Q1', title: 'Which branch?' }),
    item({ id: 'Q2', title: 'Ship behind a flag?' }),
    item({ id: 'M1', title: 'Proposed', kind: 'milestone', proposal: { action: 'done', by: 'claude', note: 'x', at: '' } }),
  ] });

  it('shows a question the chat already asks once, from the chat, and the rest from the plan', () => {
    expect(planQuestionFor(plan, chat('Which branch?'))?.id).toBe('Q1');
    expect(planQuestionsForYou(plan, [chat('Which branch?')]).map((question) => question.id)).toEqual(['Q2']);
    expect(planQuestionsForYou(plan, []).map((question) => question.id)).toEqual(['Q1', 'Q2']);
    expect(planQuestionsForYou(undefined, [])).toEqual([]);
  });
});

describe('what the AI closed', () => {
  const plan = view({
    milestones: [item({ id: 'M1', title: 'Chat docked', kind: 'milestone' }), item({ id: 'M2', title: 'Reader', kind: 'milestone' })],
    changes: [
      change({ itemId: 'M2', action: 'reopened', by: 'codex', at: '2026-10-15T12:00:00.000Z', note: 'Tabs lose their place' }),
      change({ itemId: 'T1', action: 'done', by: 'claude', at: '2026-10-15T11:30:00.000Z' }),
      change({ itemId: 'M1', action: 'done', by: 'claude', at: '2026-10-15T11:00:00.000Z' }),
      change({ itemId: 'M1', action: 'done', by: 'user', at: '2026-10-14T11:00:00.000Z' }),
      change({ itemId: 'M2', action: 'imported', by: 'contextspace', at: '2026-10-01T11:00:00.000Z' }),
    ],
  });

  it('lists the milestones an AI closed or reopened since the developer last looked, newest first', () => {
    expect(aiCloses(plan, undefined).map((entry) => `${entry.by} ${entry.action} ${entry.itemId}`)).toEqual(['codex reopened M2', 'claude done M1']);
    expect(aiCloses(plan, '2026-10-15T11:00:00.000Z').map((entry) => entry.itemId)).toEqual(['M2']);
    expect(aiCloses(undefined, undefined)).toEqual([]);
  });

  it('knows an AI tool from the developer and from ContextSpace', () => {
    expect(byAi('claude')).toBe(true);
    expect(byAi('agent')).toBe(true);
    expect(byAi('user')).toBe(false);
    expect(byAi('ContextSpace')).toBe(false);
  });
});
