import { describe, expect, it } from 'vitest';
import type { ReaderTarget } from './boardActions.js';
import { TRAIL_CAP, backLabel, backTarget, backTrail, canGoBack, pushTrail, startTrail } from './boardReaderTrail.js';

const file = (path: string): ReaderTarget => ({ path, title: path });
const commit: ReaderTarget = { path: 'repo · abcdef1', title: 'Add a thing', commit: { repo: 'repo', sha: 'abcdef1234567' } };

describe('boardReaderTrail', () => {
  it('a new trail has nowhere to go back to', () => {
    const trail = startTrail(commit);
    expect(canGoBack(trail)).toBe(false);
    expect(backTarget(trail)).toBeNull();
    expect(backTrail(trail)).toBe(trail);
  });

  it('push adds a place and back returns to the one before', () => {
    const one = pushTrail(startTrail(commit), file('a.png'));
    expect(canGoBack(one)).toBe(true);
    expect(backTarget(one)).toBe(commit);
    const back = backTrail(one);
    expect(back.entries).toEqual([commit]);
    expect(back.origin).toBe(commit);
  });

  it('three deep and back twice', () => {
    const t = pushTrail(pushTrail(startTrail(commit), file('a.md')), file('b.png'));
    expect(t.entries).toHaveLength(3);
    const twice = backTrail(backTrail(t));
    expect(twice.entries).toEqual([commit]);
    expect(canGoBack(twice)).toBe(false);
  });

  it('following the place already shown adds nothing', () => {
    const t = pushTrail(startTrail(commit), file('a.png'));
    expect(pushTrail(t, file('a.png'))).toBe(t);
    const s = startTrail(commit);
    expect(pushTrail(s, { ...commit })).toEqual(s);
  });

  it('stamps a monotonic id in startTrail, preserved across push and back', () => {
    const t1 = startTrail(commit);
    const t2 = startTrail(commit);
    expect(t2.id).toBeGreaterThan(t1.id);
    const pushed = pushTrail(t1, file('a.png'));
    expect(pushed.id).toBe(t1.id);
    const back = backTrail(pushed);
    expect(back.id).toBe(t1.id);
  });

  it('keeps 20 places, dropping the oldest, and the origin', () => {
    let t = startTrail(commit);
    for (let i = 0; i < 30; i += 1) t = pushTrail(t, file(`f${i}.png`));
    expect(t.entries).toHaveLength(TRAIL_CAP);
    expect(t.entries[0]!.path).toBe('f10.png');
    expect(t.entries[TRAIL_CAP - 1]!.path).toBe('f29.png');
    expect(t.origin).toBe(commit);
  });

  it('names a commit by its short sha and a file by its title', () => {
    expect(backLabel(commit)).toBe('abcdef1');
    expect(backLabel({ path: 'x/y.md', title: 'Live development' })).toBe('Live development');
  });
});
