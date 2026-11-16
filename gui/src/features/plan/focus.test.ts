import { describe, expect, it } from 'vitest';
import { focusOf, focusSignature, focusWord, NOW_MAX_AGE_MS, stableNow, workableKeys } from './focus.js';
import type { PlanFileChange, PlanFileCheckpoint, PlanFileDecision, PlanFileStep, PlanFileView } from './planFile.js';

const step = (key: string, done = false, parent?: string): PlanFileStep => ({ key, text: `Step ${key}`, done, ...(parent ? { parent } : {}) });
const decision = (key: string, done = false): PlanFileDecision => ({ key, question: `Decision ${key}?`, done, suggested: [] });
const checkpoint = (key: string, steps: PlanFileStep[], done = false, decisions: PlanFileDecision[] = []): PlanFileCheckpoint => ({ key, title: `Checkpoint ${key}`, done, steps, decisions });
const plan = (checkpoints: PlanFileCheckpoint[], steps: PlanFileStep[] = [], changes?: PlanFileChange[]) =>
  ({ checkpoints, steps, ...(changes ? { changes } : {}) } as Pick<PlanFileView, 'checkpoints' | 'steps'> & { changes?: PlanFileChange[] });

const CLOCK = Date.parse('2026-11-06T12:00:00.000Z');
const isoAgo = (ms: number) => new Date(CLOCK - ms).toISOString();
const record = (key: string, ageMs = 5 * 60_000, by = 'claude') => ({ key, by, at: isoAgo(ageMs) });
const change = (
  key: string,
  action: PlanFileChange['action'] = 'ticked',
  ageMs = 5 * 60_000,
  kind: PlanFileChange['kind'] = 'step',
): PlanFileChange => ({ at: isoAgo(ageMs), by: 'claude', action, kind, key, text: `Item ${key}` });

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

  describe('where work last happened (recent changes)', () => {
    const three = plan([
      checkpoint('c1', [step('s1-1')]),
      checkpoint('c2', [step('s2-done', true), step('s2-h'), step('s2-next', false, 's2-h')]),
      checkpoint('c3', [step('s3-done', true), step('s3-h'), step('s3-open', false, 's3-h')], false, [decision('d3', true)]),
    ]);

    it('picks the open checkpoint of the newest ticked step, skipping headings to its first open workable step, and says Last worked on', () => {
      const p = { ...three, changes: [change('s3-done', 'ticked', 60_000), change('s1-1', 'added', 120_000)] };
      const focus = focusOf(p, null, CLOCK)!;
      expect(focus).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' }, step: { key: 's3-open' } });
      expect(focus.by).toBeUndefined();
      expect(focus.at).toBeUndefined();
      expect(focusWord(focus)).toBe('Last worked on');
    });

    it('walks changes newest first even if the list is not sorted newest first', () => {
      const p = { ...three, changes: [change('s2-done', 'ticked', 10 * 60_000), change('s3-done', 'ticked', 2 * 60_000)] };
      expect(focusOf(p, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' }, step: { key: 's3-open' } });
    });

    it('skips changes in a finished checkpoint and falls back to the newest change in an open checkpoint', () => {
      const withDone = plan(
        [
          checkpoint('c0', [step('done-step', true)], true),
          ...three.checkpoints,
        ],
        [],
        [change('done-step', 'ticked', 30_000), change('s2-done', 'ticked', 120_000)],
      );
      expect(focusOf(withDone, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c2' }, step: { key: 's2-next' } });
    });

    it('counts unticked, added and answered changes in open checkpoints', () => {
      expect(focusOf({ ...three, changes: [change('s3-open', 'unticked', 60_000)] }, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' } });
      expect(focusOf({ ...three, changes: [change('s3-open', 'added', 60_000)] }, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' } });
      expect(focusOf({ ...three, changes: [change('d3', 'answered', 60_000, 'decision')] }, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' }, step: { key: 's3-open' } });
    });

    it('ignores standalone removed changes, while a step edit (removed + added at the same time) matches through added', () => {
      const onlyRemoved = { ...three, changes: [change('gone-step', 'removed', 10_000)] };
      expect(focusOf(onlyRemoved, null, CLOCK)).toMatchObject({ source: 'plan', checkpoint: { key: 'c1' }, step: { key: 's1-1' } });

      const edited = {
        ...three,
        changes: [
          change('old-wording', 'removed', 10_000),
          change('s3-open', 'added', 10_000),
        ],
      };
      expect(focusOf(edited, null, CLOCK)).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' }, step: { key: 's3-open' } });
    });

    it('ignores changes to loose steps or checkpoints, and keeps an open checkpoint with no workable steps left', () => {
      const looseChange = plan(three.checkpoints, [step('loose')], [change('loose', 'ticked', 10_000), change('c3', 'added', 20_000, 'checkpoint')]);
      expect(focusOf(looseChange, null, CLOCK)).toMatchObject({ source: 'plan', checkpoint: { key: 'c1' } });

      const noOpenSteps = plan([checkpoint('c1', [step('s1')]), checkpoint('c2', [step('s2-done', true)], false, [decision('d2')])], [], [change('s2-done', 'ticked', 10_000)]);
      const focus = focusOf(noOpenSteps, null, CLOCK)!;
      expect(focus).toMatchObject({ source: 'recent', checkpoint: { key: 'c2' } });
      expect(focus.step).toBeUndefined();
    });

    it('falls back to today\'s plan order when changes are empty or only in finished checkpoints', () => {
      const onlyFinished = plan([checkpoint('c0', [step('x', true)], true), checkpoint('c1', [step('s1')])], [], [change('x', 'ticked', 10_000)]);
      expect(focusOf(onlyFinished, null, CLOCK)).toMatchObject({ source: 'plan', checkpoint: { key: 'c1' }, step: { key: 's1' } });
      expect(focusOf({ ...three, changes: [] }, null, CLOCK)).toMatchObject({ source: 'plan', checkpoint: { key: 'c1' }, step: { key: 's1-1' } });
    });

    it('prefers a valid set mark over recent changes, and falls back to recent when the mark is older than 24 hours', () => {
      const p = { ...three, changes: [change('s3-done', 'ticked', 60_000)] };
      const setFocus = focusOf(p, record('s2-next', 5 * 60_000), CLOCK)!;
      expect(setFocus).toMatchObject({ source: 'set', checkpoint: { key: 'c2' }, step: { key: 's2-next' } });
      expect(focusWord(setFocus)).toBe('Now');

      const expiredFocus = focusOf(p, record('s2-next', NOW_MAX_AGE_MS + 1), CLOCK)!;
      expect(expiredFocus).toMatchObject({ source: 'recent', checkpoint: { key: 'c3' }, step: { key: 's3-open' } });
      expect(focusWord(expiredFocus)).toBe('Last worked on');
    });
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

  it('keeps stable across ticks in recent mode and moves when an expired set mark falls to recent', () => {
    const withRecent = { ...P, changes: [change('later', 'added', 60_000)] };
    const recentSig = (clock: number) => focusSignature(focusOf(withRecent, null, clock));
    const firstRecent = stableNow(undefined, recentSig(CLOCK), CLOCK);
    let held = firstRecent;
    for (let minute = 1; minute <= 30; minute += 1) held = stableNow(held, recentSig(CLOCK + minute * 60_000), CLOCK + minute * 60_000);
    expect(held).toBe(firstRecent);

    const setAt = stableNow(undefined, focusSignature(focusOf(withRecent, record('a'), CLOCK)), CLOCK);
    const later = CLOCK + NOW_MAX_AGE_MS;
    const fellToRecent = stableNow(setAt, focusSignature(focusOf(withRecent, record('a'), later)), later);
    expect(fellToRecent).not.toBe(setAt);
    expect(fellToRecent.signature.startsWith('recent|')).toBe(true);
  });
});
