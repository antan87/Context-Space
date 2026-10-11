import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  sidebarMaxFor,
} from './sidebarWidth.js';

/** A minimal localStorage, since the unit tests run without a browser. */
function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  vi.stubGlobal('localStorage', storage);
  return data;
}

const KEY = 'ctxspace_sidebar_width';

describe('clampSidebarWidth', () => {
  it('keeps a width between the minimum and the maximum, in whole pixels', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default for something that is not a number', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('never takes more than its share of a small window, and never less than the minimum', () => {
    expect(sidebarMaxFor(1000)).toBe(450);
    expect(clampSidebarWidth(480, 1000)).toBe(450);
    expect(sidebarMaxFor(2000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxFor(300)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(100, 300)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('reads an unknown window width as no limit beyond the maximum', () => {
    expect(sidebarMaxFor(0)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxFor(Number.NaN)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe('the saved sidebar width', () => {
  beforeEach(() => { stubStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is the default when nothing is saved', () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('comes back as saved', () => {
    saveSidebarWidth(340);
    expect(loadSidebarWidth()).toBe(340);
  });

  it('forgets the choice when the default is chosen again', () => {
    const data = stubStorage({ [KEY]: '340' });
    saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    expect(data.has(KEY)).toBe(false);
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('pulls a saved width that is out of range back into range', () => {
    stubStorage({ [KEY]: '9999' });
    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);
    stubStorage({ [KEY]: '12' });
    expect(loadSidebarWidth()).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('ignores a saved value that is not a width', () => {
    for (const junk of ['', '   ', 'wide', 'NaN', '{"a":1}', 'Infinity']) {
      stubStorage({ [KEY]: junk });
      expect(loadSidebarWidth(), junk).toBe(SIDEBAR_DEFAULT_WIDTH);
    }
  });

  it('works when storage cannot be read or written', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(() => saveSidebarWidth(300)).not.toThrow();
    expect(() => saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH)).not.toThrow();
  });
});
