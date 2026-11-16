import { describe, expect, it } from 'vitest';
import { READER, fileTitle, readerDock } from './boardDock.js';

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

