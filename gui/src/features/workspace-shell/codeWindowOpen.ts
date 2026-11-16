/**
 * Whether the Code window is open right now. The window stays mounted (hidden) while closed, so only the shown one counts.
 * A window-level key listener elsewhere in the app asks this first and stands down while it is open: the keys belong to the
 * window, and whatever is behind it must not hear them.
 */
export const isCodeWindowOpen = (): boolean =>
  typeof document !== 'undefined' && document.querySelector('[data-code-window-backdrop]:not([hidden]) [data-code-window]') !== null;
