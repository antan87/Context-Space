import { describe, expect, it } from 'vitest';
import { READER, fileTitle, readerDock, readerReveal } from './boardDock.js';

describe('readerDock', () => {
  it('takes 45% of the section beside the canvas', () => {
    expect(readerDock(1440)).toEqual({ covers: false, width: 648 });
    expect(readerDock(1000)).toEqual({ covers: false, width: 450 });
  });

  it('is never narrower than 360 px while the canvas keeps room beside it', () => {
    expect(readerDock(800)).toEqual({ covers: false, width: 360 });
    expect(readerDock(720)).toEqual({ covers: false, width: 360 });
  });

  it('covers the canvas when the section has no room for both', () => {
    expect(readerDock(719)).toEqual({ covers: true, width: 719 });
    expect(readerDock(400)).toEqual({ covers: true, width: 400 });
    expect(readerDock(0)).toEqual({ covers: true, width: 0 });
  });

  it('leaves the canvas at least its own minimum whenever it docks', () => {
    for (let width = 0; width <= 3000; width += 7) {
      const dock = readerDock(width);
      if (!dock.covers) {
        expect(width - dock.width).toBeGreaterThanOrEqual(READER.minCanvas);
        expect(dock.width).toBeGreaterThanOrEqual(READER.minWidth);
      }
    }
  });
});

describe('readerReveal', () => {
  const view = { x: 0, y: 0, zoom: 1 };
  const section = { width: 1440, height: 900 };

  it('leaves the view alone for a card that stays in sight beside the reader', () => {
    expect(readerReveal({ x: 100, y: 100, width: 264, height: 128 }, view, section, 40)).toBeNull();
  });

  it('moves the view just far enough for a card that would be under the reader', () => {
    // The reader takes 648 px of 1440, so the canvas shows 792 px; a card from 700 to 964 is cut off on the right.
    const moved = readerReveal({ x: 700, y: 100, width: 264, height: 128 }, view, section, 40);
    expect(moved).toEqual({ x: 792 - 40 - 264 - 700, y: 0, zoom: 1 });
  });

  it('keeps the zoom and the vertical place', () => {
    const moved = readerReveal({ x: 900, y: 100, width: 264, height: 128 }, { x: 10, y: -20, zoom: 0.8 }, section, 40);
    expect(moved?.zoom).toBe(0.8);
    expect(moved?.y).toBe(-20);
  });

  it('does nothing when the reader covers the whole canvas', () => {
    expect(readerReveal({ x: 700, y: 100, width: 264, height: 128 }, view, { width: 600, height: 900 }, 40)).toBeNull();
  });
});

describe('fileTitle', () => {
  it('is the file name at the end of the path', () => {
    expect(fileTitle('docs/export flow.md')).toBe('export flow.md');
    expect(fileTitle('notes.md')).toBe('notes.md');
    expect(fileTitle('docs/')).toBe('docs');
  });

  it('falls back to the path when nothing is left of it', () => {
    expect(fileTitle('')).toBe('');
  });
});
