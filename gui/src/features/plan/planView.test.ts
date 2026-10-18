import { describe, expect, it } from 'vitest';
import { planStatesGoal, questionWhy, suggestedAnswers, whenText, whoName } from './planView.js';

describe('whoName', () => {
  it('says You, the AI tool by name, or ContextSpace', () => {
    expect(whoName('user')).toBe('You');
    expect(whoName('agent')).toBe('The AI');
    expect(whoName('claude')).toBe('Claude');
    expect(whoName('contextspace')).toBe('ContextSpace');
    expect(whoName('PO')).toBe('PO');
  });
});

describe('planStatesGoal', () => {
  it('is true when PLAN.md opens with words, so the brief need not repeat the goal', () => {
    expect(planStatesGoal({ intro: 'Customers export their reports as **CSV**.' })).toBe(true);
    expect(planStatesGoal({ intro: '\n  One line.  \n' })).toBe(true);
  });

  it('is false while the plan is unknown, without a PLAN.md, and for an intro with nothing in it', () => {
    expect(planStatesGoal(undefined)).toBe(false);
    expect(planStatesGoal(null)).toBe(false);
    expect(planStatesGoal({})).toBe(false);
    expect(planStatesGoal({ intro: '' })).toBe(false);
    expect(planStatesGoal({ intro: ' \n\t ' })).toBe(false);
    expect(planStatesGoal({ intro: null })).toBe(false);
  });
});

describe('a question\'s words', () => {
  it('reads the answers an AI suggested with its question, and why it asks', () => {
    expect(suggestedAnswers('Why it matters\n\nSuggested answers: main · release')).toEqual(['main', 'release']);
    expect(suggestedAnswers('No suggestions')).toEqual([]);
    expect(suggestedAnswers(undefined)).toEqual([]);
    expect(questionWhy('Why it matters\n\nSuggested answers: main · release')).toBe('Why it matters');
    expect(questionWhy(undefined)).toBe('');
  });
});

describe('whenText', () => {
  it('says how long ago, and nothing for a time never recorded', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    expect(whenText('2026-10-10T11:58:00.000Z', now)).toBe('2 min ago');
    expect(whenText('2026-10-10T09:00:00.000Z', now)).toBe('3 h ago');
    expect(whenText('2026-10-09T11:00:00.000Z', now)).toBe('yesterday');
    // A check carried over without its time was stored as the epoch: no "Jan 1".
    expect(whenText('1970-01-01T00:00:00.000Z', now)).toBe('');
    expect(whenText(undefined, now)).toBe('');
  });
});
