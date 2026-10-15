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
