import { useSyncExternalStore } from 'react';

/**
 * How the chat sits with the other parts of a workspace. The chat is the centre of the
 * screen and takes most of it. Plan, Changes, Documents and the rest open as a narrower
 * panel beside it when asked for, and closing the panel gives the chat the whole width
 * back. Two choices belong to the user and are remembered: how much of the width the chat
 * keeps while a panel is open, and whether the chat is hidden for now.
 */
const STORAGE_KEY = 'contextspace_chat_layout_v1';

export const CHAT_LAYOUT = {
  defaultPercent: 50,
  minPercent: 25,
  maxPercent: 75,
  /** Below this width there is no room for a usable chat and a panel side by side, so the panel gets the screen. */
  besideMinPx: 1000,
} as const;

export interface ChatLayoutState {
  /** Hidden by the user: the other parts take the whole width. */
  hidden: boolean;
  /** The chat's share of the width while a panel is open beside it, in percent. */
  percent: number;
}

export const clampChatPercent = (percent: number): number =>
  Number.isFinite(percent) ? Math.max(CHAT_LAYOUT.minPercent, Math.min(CHAT_LAYOUT.maxPercent, Math.round(percent))) : CHAT_LAYOUT.defaultPercent;

const DEFAULT_STATE: ChatLayoutState = { hidden: false, percent: CHAT_LAYOUT.defaultPercent };

function load(): ChatLayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ChatLayoutState> | null;
    return {
      hidden: parsed?.hidden === true,
      percent: typeof parsed?.percent === 'number' ? clampChatPercent(parsed.percent) : CHAT_LAYOUT.defaultPercent,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

let current: ChatLayoutState = load();
const listeners = new Set<() => void>();

function update(next: ChatLayoutState) {
  if (next.hidden === current.hidden && next.percent === current.percent) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* Storage can be unavailable. */ }
  for (const listener of listeners) listener();
}

export const chatLayout = {
  get: () => current,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  setHidden: (hidden: boolean) => update({ ...current, hidden }),
  toggleHidden: () => update({ ...current, hidden: !current.hidden }),
  setPercent: (percent: number) => update({ ...current, percent: clampChatPercent(percent) }),
};

export function useChatLayout(): ChatLayoutState {
  return useSyncExternalStore(chatLayout.subscribe, chatLayout.get, () => DEFAULT_STATE);
}

/** Whether a panel can open beside the chat in a page this wide. */
export function hasRoomBeside(widthPx: number): boolean {
  return widthPx >= CHAT_LAYOUT.besideMinPx;
}
