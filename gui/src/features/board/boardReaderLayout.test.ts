import { afterEach, describe, expect, it, vi } from 'vitest';
import { LARGE_WINDOW, LAYOUT_KEY, cleanLayout, readLayout, writeLayout } from './boardReaderLayout.js';

/** A storage the spec holds, standing in for the browser's. */
function stubStorage(initial: Record<string, string> = {}, fails = false) {
  const data = new Map(Object.entries(initial));
  const refuse = () => { throw new Error('Storage is not available.'); };
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => (fails ? refuse() : data.get(key) ?? null),
    setItem: (key: string, value: string) => (fails ? refuse() : void data.set(key, value)),
  } });
  return data;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the large window', () => {
  it('takes about 92% of the section\'s width and 88% of its height, and leaves the board in sight all round', () => {
    expect(LARGE_WINDOW).toEqual({ width: 0.92, height: 0.88 });
    expect((1 - LARGE_WINDOW.width) / 2 * 1440).toBeGreaterThan(40);
  });
});

describe('cleanLayout', () => {
  it('is the dock only when that is what was kept, and the large window for anything else', () => {
    expect(cleanLayout('side')).toBe('side');
    expect(cleanLayout('large')).toBe('large');
    for (const odd of [null, undefined, '', 'Side', 'docked', 0, {}, ['side']]) expect(cleanLayout(odd)).toBe('large');
  });
});

describe('the kept layout', () => {
  it('is the large window until the viewer chooses', () => {
    stubStorage();
    expect(readLayout()).toBe('large');
  });

  it('is what the viewer chose, read back', () => {
    const data = stubStorage();
    writeLayout('side');
    expect(data.get(LAYOUT_KEY)).toBe('side');
    expect(readLayout()).toBe('side');
    writeLayout('large');
    expect(readLayout()).toBe('large');
  });

  it('ignores what it cannot make sense of', () => {
    stubStorage({ [LAYOUT_KEY]: '{"layout":"side"}' });
    expect(readLayout()).toBe('large');
  });

  it('shows the large window and does not fail when storage is not there to read or write', () => {
    stubStorage({}, true);
    expect(readLayout()).toBe('large');
    expect(() => writeLayout('side')).not.toThrow();
    vi.stubGlobal('window', {});
    expect(readLayout()).toBe('large');
    expect(() => writeLayout('side')).not.toThrow();
  });
});
