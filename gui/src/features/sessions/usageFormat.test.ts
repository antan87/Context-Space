import { describe, expect, it } from 'vitest';
import { formatCompact, formatHeaderQuota } from './usageFormat.js';
import type { NormalizedRemainingQuota } from '../../types.js';

describe('formatCompact', () => {
  it('formats sub-thousand integers accurately without abbreviations', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(1)).toBe('1');
    expect(formatCompact(500)).toBe('500');
    expect(formatCompact(999)).toBe('999');
  });

  it('formats exact thousand transitions and strips trailing .0', () => {
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(1049)).toBe('1k');
    expect(formatCompact(1050)).toBe('1.1k');
    expect(formatCompact(1500)).toBe('1.5k');
    // Note: In IEEE-754 floating point arithmetic, 1950 / 1000 is 1.95 which rounds to 1.9 with toFixed(1)
    expect(formatCompact(1950)).toBe('1.9k');
    expect(formatCompact(1960)).toBe('2k');
    expect(formatCompact(10000)).toBe('10k');
    expect(formatCompact(25500)).toBe('25.5k');
  });

  it('handles upper thousand boundary (999,499 vs 999,999)', () => {
    expect(formatCompact(999499)).toBe('999.5k');
    expect(formatCompact(999999)).toBe('1000k');
  });

  it('formats million transitions and strips trailing .0', () => {
    expect(formatCompact(1000000)).toBe('1M');
    expect(formatCompact(1049999)).toBe('1M');
    expect(formatCompact(1050000)).toBe('1.1M');
    expect(formatCompact(1200000)).toBe('1.2M');
    expect(formatCompact(1500000)).toBe('1.5M');
    expect(formatCompact(50000000)).toBe('50M');
    expect(formatCompact(120500000)).toBe('120.5M');
  });

  it('formats negative token values via toLocaleString (since condition checks n >= 1000)', () => {
    expect(formatCompact(-500)).toBe('-500');
    expect(formatCompact(-1500)).toBe('-1,500');
    expect(formatCompact(-2000000)).toBe('-2,000,000');
    expect(formatCompact(1234.56)).toBe('1.2k');
  });
});

describe('formatHeaderQuota', () => {
  it('returns "Quota: Unmonitored" when quota is undefined or null', () => {
    expect(formatHeaderQuota(undefined)).toBe('Quota: Unmonitored');
    expect(formatHeaderQuota(null as any)).toBe('Quota: Unmonitored');
  });

  it('enforces Branch 1: planType === "plan-included" takes highest precedence over all other fields', () => {
    const quota: NormalizedRemainingQuota = {
      planType: 'plan-included',
      contextWindow: { usedTokens: 90000, maxTokens: 100000, utilizationPercent: 90.0 },
      tokens: { unit: 'tokens', remaining: 5000 },
      requests: { unit: 'requests', remaining: 10 },
      label: 'Custom Tier',
    };
    expect(formatHeaderQuota(quota)).toBe('Plan: Included');
  });

  it('enforces Branch 2: contextWindow takes precedence over tokens, requests, and label', () => {
    const quota: NormalizedRemainingQuota = {
      contextWindow: { usedTokens: 42000, maxTokens: 100000, utilizationPercent: 42.0 },
      tokens: { unit: 'tokens', remaining: 80000 },
      requests: { unit: 'requests', remaining: 500 },
      label: 'Standard Plan',
    };
    expect(formatHeaderQuota(quota)).toBe('Context: 42.0%');
  });

  it('preserves contextWindow utilizationPercent of exactly 0.0% without falling through', () => {
    const quota: NormalizedRemainingQuota = {
      contextWindow: { usedTokens: 0, maxTokens: 128000, utilizationPercent: 0.0 },
      tokens: { unit: 'tokens', remaining: 128000 },
    };
    expect(formatHeaderQuota(quota)).toBe('Context: 0.0%');
  });

  it('enforces Branch 3: tokens.remaining takes precedence over requests and label', () => {
    const quota: NormalizedRemainingQuota = {
      tokens: { unit: 'tokens', remaining: 75000 },
      requests: { unit: 'requests', remaining: 25 },
      label: 'Developer Tier',
    };
    expect(formatHeaderQuota(quota)).toBe('Quota: 75k');
  });

  it('preserves tokens.remaining of exactly 0 without falling through', () => {
    const quota: NormalizedRemainingQuota = {
      tokens: { unit: 'tokens', remaining: 0 },
      requests: { unit: 'requests', remaining: 10 },
      label: 'Exhausted Tokens',
    };
    expect(formatHeaderQuota(quota)).toBe('Quota: 0');
  });

  it('enforces Branch 4: requests.remaining takes precedence over label', () => {
    const quota: NormalizedRemainingQuota = {
      requests: { unit: 'requests', remaining: 42 },
      label: 'API Keys',
    };
    expect(formatHeaderQuota(quota)).toBe('Quota: 42 req');
  });

  it('preserves requests.remaining of exactly 0 without falling through', () => {
    const quota: NormalizedRemainingQuota = {
      requests: { unit: 'requests', remaining: 0 },
      label: 'Rate Limited',
    };
    expect(formatHeaderQuota(quota)).toBe('Quota: 0 req');
  });

  it('enforces Branch 5: returns label when remaining counts are omitted', () => {
    const quota: NormalizedRemainingQuota = {
      label: 'Custom Enterprise Quota',
    };
    expect(formatHeaderQuota(quota)).toBe('Custom Enterprise Quota');
  });

  it('enforces Branch 6: falls back to "Quota: OK" for empty object or unrecognized fields', () => {
    expect(formatHeaderQuota({})).toBe('Quota: OK');
    expect(formatHeaderQuota({ isEstimated: true, warningMessage: 'Caution' })).toBe('Quota: OK');
  });
});
