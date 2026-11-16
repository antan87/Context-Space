import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CODE_FONT_SIZE_KEY,
  DEFAULT_CODE_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  clampCodeFontSize,
  getCodeFontSize,
  readCodeFontSize,
  resetCodeFontSizeForTesting,
  stepCodeFontSize,
  subscribeCodeFontSize,
  useCodeFontSize,
  writeCodeFontSize,
} from './codeFontSize.js';

describe('codeFontSize helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCodeFontSizeForTesting();
  });

  describe('default value', () => {
    it('returns 14 by default when storage is empty or null', () => {
      const storage = {
        getItem: vi.fn().mockReturnValue(null),
      };
      expect(readCodeFontSize(storage)).toBe(DEFAULT_CODE_FONT_SIZE);
      expect(DEFAULT_CODE_FONT_SIZE).toBe(14);
    });

    it('returns 14 when no storage is provided and global localStorage is unavailable', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(readCodeFontSize(null)).toBe(14);
    });
  });

  describe('step', () => {
    it('steps by delta of +1 or -1 within bounds', () => {
      expect(stepCodeFontSize(14, 1)).toBe(15);
      expect(stepCodeFontSize(14, -1)).toBe(13);
      expect(stepCodeFontSize(11, 1)).toBe(12);
      expect(stepCodeFontSize(20, -1)).toBe(19);
    });

    it('does not step past bounds', () => {
      expect(stepCodeFontSize(20, 1)).toBe(20);
      expect(stepCodeFontSize(11, -1)).toBe(11);
      expect(stepCodeFontSize(20, 5)).toBe(20);
      expect(stepCodeFontSize(11, -5)).toBe(11);
    });

    it('handles non-integer or invalid input', () => {
      expect(stepCodeFontSize(Number.NaN, 1)).toBe(15);
      expect(stepCodeFontSize(14.2, 1)).toBe(15);
    });
  });

  describe('bounds', () => {
    it('clamps values below minimum to 11', () => {
      expect(clampCodeFontSize(10)).toBe(MIN_CODE_FONT_SIZE);
      expect(clampCodeFontSize(0)).toBe(MIN_CODE_FONT_SIZE);
      expect(clampCodeFontSize(-10)).toBe(MIN_CODE_FONT_SIZE);
      expect(MIN_CODE_FONT_SIZE).toBe(11);
    });

    it('clamps values above maximum to 20', () => {
      expect(clampCodeFontSize(21)).toBe(MAX_CODE_FONT_SIZE);
      expect(clampCodeFontSize(100)).toBe(MAX_CODE_FONT_SIZE);
      expect(MAX_CODE_FONT_SIZE).toBe(20);
    });

    it('preserves valid values between 11 and 20', () => {
      for (let s = MIN_CODE_FONT_SIZE; s <= MAX_CODE_FONT_SIZE; s++) {
        expect(clampCodeFontSize(s)).toBe(s);
      }
    });

    it('rounds non-integers to whole pixels', () => {
      expect(clampCodeFontSize(14.4)).toBe(14);
      expect(clampCodeFontSize(14.6)).toBe(15);
    });
  });

  describe('bad stored value', () => {
    it('falls back to 14 when stored value is not a number', () => {
      const storage = { getItem: () => 'large' };
      expect(readCodeFontSize(storage)).toBe(14);
    });

    it('falls back to 14 when stored value is empty whitespace', () => {
      const storage = { getItem: () => '   ' };
      expect(readCodeFontSize(storage)).toBe(14);
    });

    it('falls back to 14 when stored value is below minimum (< 11)', () => {
      const storage = { getItem: () => '9' };
      expect(readCodeFontSize(storage)).toBe(14);
    });

    it('falls back to 14 when stored value is above maximum (> 20)', () => {
      const storage = { getItem: () => '28' };
      expect(readCodeFontSize(storage)).toBe(14);
    });

    it('falls back to 14 when stored value is a non-integer float string', () => {
      const storage = { getItem: () => '14.5' };
      expect(readCodeFontSize(storage)).toBe(14);
    });
  });

  describe('storage throwing', () => {
    it('falls back to 14 when getItem throws an exception', () => {
      const storage = {
        getItem: () => {
          throw new DOMException('QuotaExceeded or SecurityError', 'SecurityError');
        },
      };
      expect(readCodeFontSize(storage)).toBe(14);
    });

    it('does not throw when writeCodeFontSize encounters setItem throwing', () => {
      const storage = {
        setItem: () => {
          throw new DOMException('QuotaExceeded', 'QuotaExceededError');
        },
      };
      expect(() => writeCodeFontSize(16, storage)).not.toThrow();
      expect(writeCodeFontSize(16, storage)).toBe(16);
    });

    it('keeps size in memory for the visit when setItem throws so stepping does not stick and views do not revert to 14', () => {
      const stored: string | null = null;
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => stored),
        setItem: vi.fn(() => {
          throw new DOMException('QuotaExceeded', 'QuotaExceededError');
        }),
      });

      let view1SetSize!: (next: number | ((prev: number) => number)) => void;
      function View1() {
        const [size, setSize] = useCodeFontSize();
        view1SetSize = setSize;
        return createElement('div', { 'data-testid': 'view1' }, String(size));
      }
      function View2() {
        const [size] = useCodeFontSize();
        return createElement('div', { 'data-testid': 'view2' }, String(size));
      }

      // Initial view 1 starts at 14
      expect(renderToStaticMarkup(createElement(View1))).toContain('14');

      // Step twice using the hook's setter function: 14 -> 15 -> 16
      view1SetSize((prev) => stepCodeFontSize(prev, 1));
      view1SetSize((prev) => stepCodeFontSize(prev, 1));

      // With storage throwing, stepping should not stick at 15
      expect(getCodeFontSize()).toBe(16);

      // Switching to View 2 must receive 16 from memory, not revert to 14
      expect(renderToStaticMarkup(createElement(View2))).toContain('16');
    });
  });

  describe('write and subscribe', () => {
    it('writes clamped value to storage and notifies subscribers', () => {
      const map = new Map<string, string>();
      const storage = {
        setItem: (key: string, val: string) => { map.set(key, val); },
      };
      const subscriber = vi.fn();
      const unsubscribe = subscribeCodeFontSize(subscriber);

      try {
        const result = writeCodeFontSize(16, storage);
        expect(result).toBe(16);
        expect(map.get(CODE_FONT_SIZE_KEY)).toBe('16');
        expect(subscriber).toHaveBeenCalledWith(16);

        writeCodeFontSize(25, storage);
        expect(map.get(CODE_FONT_SIZE_KEY)).toBe('20');
        expect(subscriber).toHaveBeenCalledWith(20);
      } finally {
        unsubscribe();
      }
    });
  });
});
