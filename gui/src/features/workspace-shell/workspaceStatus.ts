import type { VerificationGateTelemetry } from '../cockpit/cockpitStore.js';

/** The checks in plain words, for the header. How long they took is in the tooltip, not the label. */
export function verificationText(gate: VerificationGateTelemetry) {
  if (gate.overallStatus === 'pass') return 'Checks passed';
  if (gate.overallStatus === 'fail') return 'Checks failed';
  if (gate.overallStatus === 'running') return 'Checking…';
  return 'Not checked yet';
}

/** The tooltip on the header's checks: what ran and how long it took, from recorded evidence only. */
export function verificationTitle(gate: VerificationGateTelemetry): string | undefined {
  const took = gate.overallStatus === 'pass' && gate.durationMs !== undefined ? `The tests passed in ${(gate.durationMs / 1000).toFixed(1)} s.` : '';
  return [gate.summaryText, took].filter(Boolean).join(' ') || undefined;
}
