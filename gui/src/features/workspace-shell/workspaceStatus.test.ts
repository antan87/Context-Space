import { describe, expect, it } from 'vitest';
import { nextLine, verificationText } from './workspaceStatus.js';

const ref = (id: string, title: string) => ({ id, label: `${id} ${title}`, title });

describe('nextLine', () => {
  it('names the plan\'s Next, and what it waits for when it cannot start', () => {
    expect(nextLine({ next: { ...ref('M3', 'Reader with tabs'), waitsFor: [] } })).toEqual({ title: 'Reader with tabs' });
    expect(nextLine({ current: ref('M2', 'Chat docked'), next: { ...ref('M3', 'Reader with tabs'), waitsFor: [ref('M2', 'Chat docked'), ref('Q9', 'Review placement?')] } }))
      .toEqual({ title: 'Reader with tabs', waits: 'waits for Chat docked, Review placement?' });
    expect(nextLine({ next: { ...ref('M3', 'Reader'), waitsFor: [], blockedReason: 'No design yet' } })).toEqual({ title: 'Reader', waits: 'blocked: No design yet' });
    expect(nextLine({})).toBeUndefined();
    expect(nextLine(undefined)).toBeUndefined();
  });
});

describe('verificationText', () => {
  it('reports only recorded evidence', () => {
    expect(verificationText({ overallStatus: 'pass', durationMs: 2400 })).toBe('Verified (2.4s)');
    expect(verificationText({ overallStatus: 'pass' })).toBe('Verified');
    expect(verificationText({ overallStatus: 'fail' })).toBe('Verification failed');
    expect(verificationText({ overallStatus: 'idle' })).toBe('Not verified yet');
  });
});
