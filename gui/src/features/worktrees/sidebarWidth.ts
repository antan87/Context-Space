/**
 * The width of the expanded sidebar, which the person can drag. The collapsed rail, the narrow-window rail and the
 * full-width mobile sheet each keep their own width and ignore it.
 * File: gui/src/features/worktrees/sidebarWidth.ts
 */
import { useCallback, useEffect, useState } from 'react';

export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 480;
/** What one arrow key moves it by, and what a held Shift moves it by. */
export const SIDEBAR_KEY_STEP = 16;
export const SIDEBAR_KEY_STEP_LARGE = 48;
/** The most of the window the sidebar may take, so the chat and the pages keep their room on a small screen. */
const MAX_SHARE_OF_WINDOW = 0.45;

const STORAGE_KEY_WIDTH = 'ctxspace_sidebar_width';

/** The widest the sidebar may be in a window this wide. Never narrower than the minimum. */
export function sidebarMaxFor(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDEBAR_MAX_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth * MAX_SHARE_OF_WINDOW)));
}

/** A width the sidebar can have: whole pixels between the minimum and the most this window allows. */
export function clampSidebarWidth(value: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(sidebarMaxFor(viewportWidth), Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/** The saved width, or the default when nothing usable is saved. Storage may be unavailable or hold anything. */
export function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (raw === null || raw.trim() === '') return SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

/** The default is the absence of a choice, so choosing it again forgets the saved width. */
export function saveSidebarWidth(width: number): void {
  try {
    if (width === SIDEBAR_DEFAULT_WIDTH) localStorage.removeItem(STORAGE_KEY_WIDTH);
    else localStorage.setItem(STORAGE_KEY_WIDTH, String(width));
  } catch (err) {
    void err;
  }
}

export function useSidebarWidth() {
  const [width, setWidthState] = useState<number>(loadSidebarWidth);

  // Another window of the app changed it.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_WIDTH) setWidthState(loadSidebarWidth());
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  /** Moves the sidebar. A drag passes persist=false while it goes and saves the width where it ends. */
  const setWidth = useCallback((next: number, persist = true) => {
    const clamped = clampSidebarWidth(next, typeof window === 'undefined' ? undefined : window.innerWidth);
    setWidthState(clamped);
    if (persist) saveSidebarWidth(clamped);
    return clamped;
  }, []);

  const reset = useCallback(() => setWidth(SIDEBAR_DEFAULT_WIDTH), [setWidth]);

  return { width, setWidth, reset };
}
