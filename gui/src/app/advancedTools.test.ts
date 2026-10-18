import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADVANCED_TOOLS_STORAGE_KEY, readAdvancedToolsOpen, writeAdvancedToolsOpen } from './advancedTools.js';

/** A minimal localStorage, since the unit tests run without a browser. */
function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('the remembered state of Advanced tools', () => {
  it('is folded away until the viewer opens it', () => {
    stubStorage();
    expect(readAdvancedToolsOpen()).toBe(false);
  });

  it('remembers open and closed', () => {
    const data = stubStorage();
    writeAdvancedToolsOpen(true);
    expect(data.get(ADVANCED_TOOLS_STORAGE_KEY)).toBe('true');
    expect(readAdvancedToolsOpen()).toBe(true);
    writeAdvancedToolsOpen(false);
    expect(readAdvancedToolsOpen()).toBe(false);
  });

  it('reads anything but "true" as folded away', () => {
    stubStorage({ [ADVANCED_TOOLS_STORAGE_KEY]: 'yes' });
    expect(readAdvancedToolsOpen()).toBe(false);
  });

  it('works without storage: it reads as folded away and writing does not throw', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    });
    expect(readAdvancedToolsOpen()).toBe(false);
    expect(() => writeAdvancedToolsOpen(true)).not.toThrow();
  });
});
