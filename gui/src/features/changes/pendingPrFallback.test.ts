import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_PR_REFETCH_DELAYS_MS, startPendingPrFallback } from './pendingPrFallback';

describe('pending PR fallback refetch (missed commits event)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses the bounded delays 5 s then 15 s', () => {
    expect(PENDING_PR_REFETCH_DELAYS_MS).toEqual([5_000, 15_000]);
  });

  it('after the reconnect race leaves a response pending with no commits event: refetches at 5 s, again 15 s later, then stops', () => {
    const calls: number[] = [];
    const start = Date.now();
    // The feed reconnected before the pending response arrived, so nothing else will ever ask: only the fallback can.
    let spent = 0;
    const stop = startPendingPrFallback(() => true, () => calls.push(Date.now() - start), undefined, undefined, () => { spent += 1; });
    vi.advanceTimersByTime(4_999);
    expect(spent).toBe(0);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([5_000]);
    vi.advanceTimersByTime(14_999);
    expect(calls).toEqual([5_000]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([5_000, 20_000]);
    expect(spent, 'the budget is reported spent once, with the second ask').toBe(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls).toEqual([5_000, 20_000]);
    stop();
  });

  it('stops asking as soon as the PRs settle, or when it is stopped', () => {
    let pending = true;
    const refetch = vi.fn();
    const stop = startPendingPrFallback(() => pending, refetch);
    vi.advanceTimersByTime(5_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    pending = false;
    vi.advanceTimersByTime(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const stopSecond = startPendingPrFallback(() => true, second);
    stopSecond();
    vi.advanceTimersByTime(60_000);
    expect(second).not.toHaveBeenCalled();
    stop();
  });
});
