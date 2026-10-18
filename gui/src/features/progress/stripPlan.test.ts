import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '../../types.js';
import type { PlanFileChange, PlanFileView } from '../plan/planFile.js';
import { aiCloses, byAi, planQuestionFor, planQuestionsForYou, sameQuestion } from './stripPlan.js';

const change = (fields: Partial<PlanFileChange> & Pick<PlanFileChange, 'key' | 'action' | 'by' | 'at'>): PlanFileChange => ({ kind: 'checkpoint', text: fields.key, ...fields });
const view = (fields: Partial<PlanFileView>): PlanFileView => ({
  file: 'PLAN.md', source: 'file', title: 'Plan', intro: '', sections: [], checkpoints: [], steps: [], decisions: [], waiting: [], changes: [], ...fields,
});
const chat = (message: string): OpenQuestion => ({ id: message, timestamp: '2026-10-15T10:00:00.000Z', harness: 'claude', message } as OpenQuestion);

describe('sameQuestion', () => {
  it('matches a chat question to its words in the plan, whole or cut short', () => {
    expect(sameQuestion('Which branch?', '  Which   branch? ')).toBe(true);
    expect(sameQuestion('Should the reader open tabs…', 'Should the reader open tabs or windows, and keep the scroll?')).toBe(true);
    expect(sameQuestion('Which branch?', 'Which branch should I use?')).toBe(false);
  });
});

describe('the questions in the strip', () => {
  const plan = view({
    checkpoints: [{ key: 'reader', title: 'Reader', done: false, steps: [], decisions: [
      { key: 'which-branch', question: 'Which branch?', done: false, suggested: ['main', 'release'], checkpoint: 'reader' },
      { key: 'old', question: 'Answered already?', done: true, answer: 'Yes', suggested: [], checkpoint: 'reader' },
    ] }],
    decisions: [{ key: 'ship-behind-a-flag', question: 'Ship behind a flag?', done: false, suggested: [], ifNoAnswer: 'no flag' }],
    waiting: ['which-branch', 'ship-behind-a-flag'],
    changes: [change({ key: 'which-branch', kind: 'decision', action: 'added', by: 'claude', at: new Date().toISOString() })],
  });

  it('shows a decision the chat already asks once, from the chat, and the rest from the plan, with who asked and what it holds up', () => {
    expect(planQuestionFor(plan, chat('Which branch?'))?.id).toBe('which-branch');
    expect(planQuestionsForYou(plan, [chat('Which branch?')]).map((question) => question.id)).toEqual(['ship-behind-a-flag']);
    const [branch, flag] = planQuestionsForYou(plan, []);
    expect(branch).toMatchObject({ title: 'Which branch?', context: 'Claude asked now · holds up Reader', detail: 'Suggested answers: main · release' });
    expect(flag).toMatchObject({ context: 'Waits for you', detail: "If you don't answer: no flag" });
    expect(planQuestionsForYou(undefined, [])).toEqual([]);
  });
});

describe('what the AI closed', () => {
  const plan = view({
    changes: [
      change({ key: 'reader', action: 'ticked', by: 'file', at: '2026-10-15T12:00:00.000Z', text: 'Reader' }),
      change({ key: 'tabs', kind: 'step', action: 'ticked', by: 'claude', at: '2026-10-15T11:30:00.000Z' }),
      change({ key: 'chat-docked', action: 'ticked', by: 'claude', at: '2026-10-15T11:00:00.000Z', text: 'Chat docked' }),
      change({ key: 'chat-docked', action: 'ticked', by: 'user', at: '2026-10-14T11:00:00.000Z' }),
    ],
  });

  it('lists the checkpoints an AI ticked since the developer last looked, newest first', () => {
    expect(aiCloses(plan, undefined).map((entry) => `${entry.by} ${entry.label}`)).toEqual(['agent Reader', 'claude Chat docked']);
    expect(aiCloses(plan, '2026-10-15T11:00:00.000Z').map((entry) => entry.itemId)).toEqual(['reader']);
    expect(aiCloses(undefined, undefined)).toEqual([]);
  });

  it('knows an AI from the developer and from ContextSpace', () => {
    expect(byAi('claude')).toBe(true);
    expect(byAi('file')).toBe(true);
    expect(byAi('user')).toBe(false);
    expect(byAi('ContextSpace')).toBe(false);
  });
});
