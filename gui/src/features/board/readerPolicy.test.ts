import { describe, it, expect } from 'vitest';
import { ESCAPE_MESSAGE } from '../work-guidance/previewPolicy.js';

describe('readerPolicy and browsing constants', () => {
  it('exports ESCAPE_MESSAGE as "contextspace:escape", matching backend view-routes', () => {
    expect(ESCAPE_MESSAGE).toBe('contextspace:escape');
  });
});
