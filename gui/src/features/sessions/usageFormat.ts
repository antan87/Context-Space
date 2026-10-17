/**
 * @module features/sessions/usageFormat
 * Short text for a session's token use and what is left of its quota.
 */
import type { NormalizedRemainingQuota } from '../../types.js';

export function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return n.toLocaleString();
}

export function formatHeaderQuota(quota?: NormalizedRemainingQuota): string {
  if (!quota) return 'Quota: Unmonitored';
  if (quota.planType === 'plan-included') return 'Plan: Included';
  if (quota.contextWindow?.utilizationPercent !== undefined) {
    return `Context: ${quota.contextWindow.utilizationPercent.toFixed(1)}%`;
  }
  if (quota.tokens?.remaining !== undefined) {
    return `Quota: ${formatCompact(quota.tokens.remaining)}`;
  }
  if (quota.requests?.remaining !== undefined) {
    return `Quota: ${quota.requests.remaining} req`;
  }
  if (quota.label) return quota.label;
  return 'Quota: OK';
}
