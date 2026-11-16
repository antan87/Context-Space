import { useEffect, useState } from 'react';

/** How often the clock ticks while the page shows. */
export const CLOCK_TICK_MS = 60_000;

interface ClockHost {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (id: never) => void;
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
  document: { visibilityState: string; addEventListener: (type: string, handler: () => void) => void; removeEventListener: (type: string, handler: () => void) => void };
}

/**
 * Calls `onTick` every minute while the page is visible, when the window gets the focus and when the page becomes visible again.
 * Returns the function that stops it. The host is the window, passed in so that the rules are tested with a fake clock.
 */
export function subscribeClock(onTick: () => void, host: ClockHost = window as unknown as ClockHost, periodMs = CLOCK_TICK_MS): () => void {
  const visible = () => host.document.visibilityState !== 'hidden';
  const timer = host.setInterval(() => { if (visible()) onTick(); }, periodMs);
  const onFocus = () => onTick();
  const onVisibility = () => { if (visible()) onTick(); };
  host.addEventListener('focus', onFocus);
  host.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    host.clearInterval(timer as never);
    host.removeEventListener('focus', onFocus);
    host.document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * The time now, as a number that moves on every minute, on the window's focus and when the page shows again: what anything that says
 * "5 min ago" or goes stale after a day (the focus step) is worked out from, so an idle screen does not keep a claim that has run out.
 */
export function useClockTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeClock(() => setNow(Date.now())), []);
  return now;
}
