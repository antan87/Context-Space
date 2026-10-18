import { describe, expect, it } from 'vitest';
import { verificationText, verificationTitle } from './workspaceStatus.js';


describe('verificationText', () => {
  it('reports only recorded evidence', () => {
    expect(verificationText({ overallStatus: 'pass', durationMs: 2400 })).toBe('Checks passed');
    expect(verificationText({ overallStatus: 'fail' })).toBe('Checks failed');
    expect(verificationText({ overallStatus: 'running' })).toBe('Checking…');
    expect(verificationText({ overallStatus: 'idle' })).toBe('Not checked yet');
    // How long they took is in the tooltip, and never invented.
    expect(verificationTitle({ overallStatus: 'pass', durationMs: 2400 })).toBe('The tests passed in 2.4 s.');
    expect(verificationTitle({ overallStatus: 'pass' })).toBeUndefined();
    expect(verificationTitle({ overallStatus: 'fail', summaryText: 'api: exit code 1' })).toBe('api: exit code 1');
  });
});
