import { describe, expect, it } from 'vitest';
import { miniShowsPicture } from './boardAreas.js';

describe('miniShowsPicture', () => {
  it('needs 240 x 92', () => {
    expect(miniShowsPicture(239, 100, false)).toBe(false);
    expect(miniShowsPicture(240, 91, false)).toBe(false);
    expect(miniShowsPicture(240, 92, false)).toBe(true);
  });

  it('with no status it shows from 92 px high', () => {
    expect(miniShowsPicture(240, 95, false)).toBe(true);
  });

  it('with a status on the steps line (under 96 px) it shows no picture', () => {
    expect(miniShowsPicture(240, 92, true)).toBe(false);
    expect(miniShowsPicture(248, 95, true)).toBe(false);
  });

  it('with a status line of its own (96 px and up) it shows the picture', () => {
    expect(miniShowsPicture(240, 96, true)).toBe(true);
    expect(miniShowsPicture(240, 124, true)).toBe(true);
  });
});
