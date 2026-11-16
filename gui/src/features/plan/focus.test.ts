import { describe, expect, it } from 'vitest';
import { focusOf, focusSignature, focusWord, NOW_MAX_AGE_MS, stableNow, workableKeys } from './focus.js';
import type { PlanFileCheckpoint, PlanFileStep, PlanFileView } from './planFile.js';

const step = (key: string, done = false, parent?: string): PlanFileStep => ({ key, text: `Step ${key}`, done, ...(parent ? { parent } : {}) });
const checkpoint = (key: string, steps: PlanFileStep[], done = false): PlanFileCheckpoint => ({ key, title: `Checkpoint ${key}`, done, steps, decisions: [] });
const plan = (checkpoints: PlanFileCheckpoint[], steps: PlanFileStep[] = []) => ({ checkpoints, steps } as Pick<PlanFileView, 'checkpoints' | 'steps'>);

const CLOCK = Date.parse('2026-11-06T12:00:00.000Z');
const record = (key: string, ageMs = 5 * 60_000, by = 'claude') => ({ key, by, at: new Date(CLOCK - ageMs).toISOString() });

const P = plan([
  checkpoint('c1', [step('h1'), step('a', false, 'h1'), step('b', false, 'h1'), step('c')]),
  checkpoint('c2', [step('later')]),
]);

describe('focusOf', () => {
  it('is the step someone said they work on, even in a later checkpoint, with who and when', () => {
    const focus = focusOf(P, record('later'), CLOCK)!;
    expect(focus).toMatchObject({ source: 'set', by: 'claude', step: { key: 'later' }, checkpoint: { key: 'c2' } });
    expect(focus.at).toBe(record('later').at);
    expect(focusWord(focus)).toBe('Now');
  });

  it('reads the record from the plan when none is passed', () => {
    expect(focusOf({ ...P, now: record('later') }, undefined, CLOCK)).toMatchObject({ source: 'set', step: { key: 'later' } });
    expect(focusOf({ ...P, now: record('later') }, null, CLOCK)).toMatchObject({ source: 'plan' });
  });

  it('finds a step outside the checkpoints', () => {
    const loose = plan(P.checkpoints, [step('loose')]);
    expect(focusOf(loose, record('loose'), CLOCK)).toMatchObject({ source: 'set', step: { key: 'loose' }, checkpoint: null });
  });

  it('falls back to the plan order when the step is done, missing, a heading or older than 24 hours', () => {
    const done = plan([checkpoint('c1', [step('a', true), step('c')])]);
    for (const [from, rec] of [
      [done, record('a')],
      [P, record('gone')],
      [P, record('h1')],
      [P, record('later', NOW_MAX_AGE_MS + 1)],
      [P, { key: 'later', by: 'claude', at: 'not a date' }],
    ] as const) {
      const focus = focusOf(from, rec, CLOCK)!;
      expect(focus.source).toBe('plan');
      expect(focus.by).toBeUndefined();
      expect(focusWord(focus)).toBe('Next up');
    }
    expect(focusOf(P, record('later', NOW_MAX_AGE_MS), CLOCK)!.source).toBe('set');
  });

  it('with none set is the first open checkpoint and its first step that is not a heading', () => {
    expect(focusOf(P, null, CLOCK)).toMatchObject({ source: 'plan', step: { key: 'a' }, checkpoint: { key: 'c1' } });
    const finished = plan([checkpoint('c0', [step('x', true)], true), checkpoint('c1', [step('y')])]);
    expect(focusOf(finished, null, CLOCK)).toMatchObject({ checkpoint: { key: 'c1' }, step: { key: 'y' } });
  });

  it('keeps the checkpoint when it has no open step to work on', () => {
    const none = plan([checkpoint('c1', [step('x', true)])]);
    const focus = focusOf(none, null, CLOCK)!;
    expect(focus.checkpoint?.key).toBe('c1');
    expect(focus.step).toBeUndefined();
  });

  it('is the first open loose step once every checkpoint is done, and null when nothing is open', () => {
    expect(focusOf(plan([checkpoint('c1', [], true)], [step('l1', true), step('l2')]), null, CLOCK)).toMatchObject({ source: 'plan', step: { key: 'l2' }, checkpoint: null });
    expect(focusOf(plan([checkpoint('c1', [step('x', true)], true)], [step('l1', true)]), null, CLOCK)).toBeNull();
    expect(focusOf(plan([]), null, CLOCK)).toBeNull();
    expect(focusOf(undefined, record('a'), CLOCK)).toBeNull();
  });
});

describe('workableKeys', () => {
  it('lists open steps that are not headings', () => {
    expect([...workableKeys(plan(P.checkpoints, [step('l')]))].sort()).toEqual(['a', 'b', 'c', 'l', 'later']);
  });
});

describe('a tick does not rebuild the Areas unless the focus changed', () => {
  const signatureAt = (clock: number, rec = record('later')) => focusSignature(focusOf(P, rec, clock));

  it('keeps the same time (so the same Areas) across ticks while the focus is the same', () => {
    const first = stableNow(undefined, signatureAt(CLOCK), CLOCK);
    let held = first;
    for (let minute = 1; minute <= 30; minute += 1) held = stableNow(held, signatureAt(CLOCK + minute * 60_000), CLOCK + minute * 60_000);
    expect(held).toBe(first);
  });

  it('moves on when the focus is a different one: another step, or the set step running out after a day', () => {
    const first = stableNow(undefined, signatureAt(CLOCK), CLOCK);
    const later = CLOCK + NOW_MAX_AGE_MS;
    const expired = stableNow(first, signatureAt(later), later);
    expect(expired).not.toBe(first);
    expect(expired.at).toBe(later);
    const other = stableNow(first, focusSignature(focusOf(P, record('c'), CLOCK)), CLOCK);
    expect(other).not.toBe(first);
  });
});
