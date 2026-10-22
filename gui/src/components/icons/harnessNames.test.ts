import { describe, expect, it } from 'vitest';

import { harnessName } from './harnessNames.js';
import { harnessName as fromIcon } from './HarnessIcon.js';

describe('harnessName', () => {
  it('uses one shared map, also exported from HarnessIcon', () => {
    expect(fromIcon).toBe(harnessName);
  });

  it('names the known tools by id and by the longer labels the API sends', () => {
    expect(harnessName('claude')).toBe('Claude Code');
    expect(harnessName('Antigravity (agy)')).toBe('Antigravity');
    expect(harnessName('cursor')).toBe('Cursor Agent');
    expect(harnessName('pi')).toBe('Pi');
    expect(harnessName('shell')).toBe('Shell');
    expect(harnessName('')).toBe('');
  });

  it('shows an unknown tool as it was named, without a trailing "(binary)"', () => {
    expect(harnessName('Acme Agent (acme)')).toBe('Acme Agent');
    expect(harnessName('acme')).toBe('acme');
  });

  it('names an unknown tool from the registry when the caller has it', () => {
    const known = [{ id: 'acme', name: 'Acme Agent (acme)' }];
    expect(harnessName('acme', known)).toBe('Acme Agent');
    // The shared map still wins for the tools it knows.
    expect(harnessName('claude', [{ id: 'claude', name: 'Something else' }])).toBe('Claude Code');
    expect(harnessName('other', known)).toBe('other');
  });
});
