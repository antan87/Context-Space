export const QUICK_SWITCH_OPEN_EVENT = 'ctxspace:quick-switch';

/** Opens Jump to from anywhere: the field in the full sidebar, the rail's icon, or a test. */
export function openQuickSwitch() {
  window.dispatchEvent(new Event(QUICK_SWITCH_OPEN_EVENT));
}
