/**
 * @module app/advancedTools
 * Whether the sidebar's "Advanced tools" (Workrooms, Strategies) are open. They are folded away by default; the
 * choice is remembered per viewer, and a page of the section shows it open so the active item is never hidden.
 */
import { useCallback, useEffect, useState } from 'react';

export const ADVANCED_TOOLS_STORAGE_KEY = 'ctxspace_sidebar_advanced_open';

/** What this viewer chose last. Without storage (private window, blocked data) it is always folded away. */
export function readAdvancedToolsOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_TOOLS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeAdvancedToolsOpen(open: boolean): void {
  try {
    localStorage.setItem(ADVANCED_TOOLS_STORAGE_KEY, String(open));
  } catch {
    // The choice is not remembered; the section still opens and closes.
  }
}

/**
 * @param onAdvancedPage - The current page is one of the section's items. Arriving on one opens the section for now,
 *   without changing what is remembered, and the person can still fold it away.
 */
export function useAdvancedToolsOpen(onAdvancedPage: boolean): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => onAdvancedPage || readAdvancedToolsOpen());
  useEffect(() => {
    if (onAdvancedPage) setOpen(true);
  }, [onAdvancedPage]);
  const toggle = useCallback(() => {
    setOpen(!open);
    writeAdvancedToolsOpen(!open);
  }, [open]);
  return { open, toggle };
}
