import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK_TICK_MS, subscribeClock } from './useClockTick.js';

function fakeHost() {
  const listeners = new Map<string, Set<() => void>>();
  const docListeners = new Map<string, Set<() => void>>();
  const on = (map: Map<string, Set<() => void>>) => ({
    add: (type: string, handler: () => void) => { map.set(type, (map.get(type) ?? new Set()).add(handler)); },
    remove: (type: string, handler: () => void) => { map.get(type)?.delete(handler); },
  });
  const doc = { visibilityState: 'visible', addEventListener: on(docListeners).add, removeEventListener: on(docListeners).remove };
  return {
    host: {
      setInterval: (handler: () => void, ms: number) => setInterval(handler, ms), clearInterval: (id: never) => clearInterval(id),
      addEventListener: on(listeners).add, removeEventListener: on(listeners).remove, document: doc,
    },
    doc, fire: (type: string) => listeners.get(type)?.forEach((h) => h()), fireDoc: (type: string) => docListeners.get(type)?.forEach((h) => h()),
    count: () => [...listeners.values(), ...docListeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe('subscribeClock', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ticks every minute while the page shows, and not while it is hidden', () => {
    const { host, doc } = fakeHost();
    const tick = vi.fn();
    subscribeClock(tick, host);
    vi.advanceTimersByTime(CLOCK_TICK_MS * 3);
    expect(tick).toHaveBeenCalledTimes(3);
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(CLOCK_TICK_MS * 5);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('ticks when the window gets the focus and when the page shows again, and stops when told', () => {
    const { host, doc, fire, fireDoc, count } = fakeHost();
    const tick = vi.fn();
    const stop = subscribeClock(tick, host);
    fire('focus');
    expect(tick).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    fireDoc('visibilitychange');
    expect(tick).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
    expect(count()).toBe(0);
    vi.advanceTimersByTime(CLOCK_TICK_MS * 2);
    fire('focus');
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
