import { useEffect, useRef, useState } from 'react';

/**
 * While a recent-commits response says "PR information is loading", the live feed normally sends a `commits` event when it settles.
 * If that event was missed (the feed was down and reconnected before the pending response arrived, so the reconnect check saw nothing
 * pending), a bounded fallback asks again: after 5 s, then 15 s after that, then it stops. A pending list therefore never stays
 * "loading" forever, and a stuck `gh` costs two extra requests, not a poll.
 */
export const PENDING_PR_REFETCH_DELAYS_MS: readonly number[] = [5_000, 15_000];

type Schedule = (callback: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;

/** Starts the bounded fallback; returns a function that stops it. `isPending` is read when each timer fires. */
export function startPendingPrFallback(
  isPending: () => boolean,
  refetch: () => void,
  schedule: Schedule = (callback, ms) => setTimeout(callback, ms),
  cancel: Cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onSpent: () => void = () => undefined,
): () => void {
  let handle: unknown;
  let stopped = false;
  const step = (index: number) => {
    const delay = PENDING_PR_REFETCH_DELAYS_MS[index];
    if (delay === undefined || stopped) return;
    handle = schedule(() => {
      if (stopped || !isPending()) return;
      refetch();
      if (index + 1 >= PENDING_PR_REFETCH_DELAYS_MS.length) onSpent();
      step(index + 1);
    }, delay);
  };
  step(0);
  return () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
  };
}

/**
 * Runs {@link startPendingPrFallback} while `pending` is true. Returns true once both asks are spent and the data is still pending:
 * the list then says PR information is not available right now, instead of "loading" for ever.
 */
export function usePendingPrFallbackRefetch(pending: boolean, refetch: () => void): boolean {
  const pendingRef = useRef(pending);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  const [spent, setSpent] = useState(false);
  useEffect(() => {
    if (!pending) return undefined;
    const stop = startPendingPrFallback(
      () => pendingRef.current,
      refetch,
      undefined,
      undefined,
      () => setSpent(true),
    );
    return () => {
      stop();
      setSpent(false);
    };
  }, [pending, refetch]);
  return pending && spent;
}
