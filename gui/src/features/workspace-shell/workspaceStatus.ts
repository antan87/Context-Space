import type { VerificationGateTelemetry } from '../cockpit/cockpitStore.js';
import type { PlanFocus } from '../plan/planTypes.js';

/**
 * The header's Next, read from the plan's one rule: its name, and what it waits for when it cannot
 * start yet, so the header never names work that cannot start as if it could.
 */
export function nextLine(focus: PlanFocus | undefined): { title: string; waits?: string } | undefined {
  const next = focus?.next;
  if (!next) return undefined;
  if (next.waitsFor.length) return { title: next.title, waits: `waits for ${next.waitsFor.map((item) => item.title).join(', ')}` };
  if (next.blockedReason) return { title: next.title, waits: `blocked: ${next.blockedReason}` };
  return { title: next.title };
}

export function verificationText(gate: VerificationGateTelemetry) {
  if (gate.overallStatus === 'pass') return `Verified${gate.durationMs !== undefined ? ` (${(gate.durationMs / 1000).toFixed(1)}s)` : ''}`;
  if (gate.overallStatus === 'fail') return 'Verification failed';
  if (gate.overallStatus === 'running') return 'Verifying…';
  return 'Not verified yet';
}
