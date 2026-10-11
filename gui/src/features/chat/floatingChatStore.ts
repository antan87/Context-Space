import type { TerminalLaunch } from '../terminal/client.js';
import { useSyncExternalStore } from 'react';
import { FLOATING_CHAT_STORAGE_KEY, LEGACY_FLOATING_CHAT_STORAGE_KEY } from '../../brand';

/**
 * Layout numbers for the docked chat, in one place so the persisted-state loader,
 * the split setter and the dock itself cannot drift apart. `compactBreakpointPx`
 * is the pane width below which the reader opens as a sheet over the terminal.
 * `splitBreakpointPx` is the dock width at which a second workspace fits beside
 * the first.
 */
export const CHAT_GEOMETRY = {
  compactBreakpointPx: 520,
  splitBreakpointPx: 900,
  /** Pane width at which a second docked workspace becomes usable. */
  splitMinRatio: 25,
  splitMaxRatio: 75,
} as const;

export const clampSplitRatio = (ratio: number): number =>
  Math.max(CHAT_GEOMETRY.splitMinRatio, Math.min(CHAT_GEOMETRY.splitMaxRatio, ratio));

export interface FloatingChatState {
  /** The workspaces whose chats are alive, in tab order. Every one stays mounted while it is open. */
  openTabs: string[];
  activeTab: string | null;
  splitTab: string | null;
  splitRatio: number;
  modes: Record<string, 'cli' | 'chat'>;
  harnesses: Record<string, string>;
  terminalLaunches: Record<string, TerminalLaunch>;
  drafts: Record<string, { id: string; text: string }>;
  /**
   * Goes up each time something asks to see a chat. The dock answers by going to
   * that workspace's chat, so a call from anywhere in the app lands on the screen.
   * Never saved: a reload must not navigate.
   */
  focusRequest: number;
}

const DEFAULT_STATE: FloatingChatState = {
  openTabs: [],
  activeTab: null,
  splitTab: null,
  splitRatio: 50,
  drafts: {},
  modes: {},
  harnesses: {},
  terminalLaunches: {},
  focusRequest: 0,
};

function loadState(): FloatingChatState {
  try {
    const raw = localStorage.getItem(FLOATING_CHAT_STORAGE_KEY) ?? localStorage.getItem(LEGACY_FLOATING_CHAT_STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    // Saved state from the floating window also holds its position, size and open flags. They are ignored.
    return {
      drafts: {},
      harnesses: Object.fromEntries(Object.entries(parsed.harnesses ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
      terminalLaunches: {},
      modes: Object.fromEntries(Object.entries(parsed.modes ?? {}).filter(([, mode]) => mode === 'cli' || mode === 'chat')) as Record<string, 'cli' | 'chat'>,
      openTabs: Array.isArray(parsed.openTabs) ? [...new Set<string>(parsed.openTabs.filter((t: unknown): t is string => typeof t === 'string'))] : [],
      activeTab: typeof parsed.activeTab === 'string' ? parsed.activeTab : null,
      splitTab: typeof parsed.splitTab === 'string' && parsed.splitTab !== parsed.activeTab ? parsed.splitTab : null,
      splitRatio: typeof parsed.splitRatio === 'number' && Number.isFinite(parsed.splitRatio)
        ? clampSplitRatio(parsed.splitRatio) : 50,
      focusRequest: 0,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

let currentState: FloatingChatState = loadState();
const listeners = new Set<() => void>();

function notify() {
  try {
    localStorage.setItem(FLOATING_CHAT_STORAGE_KEY, JSON.stringify({ ...currentState, terminalLaunches: {}, drafts: {}, focusRequest: 0 }));
  } catch {
    // Non-fatal if localStorage is unavailable
  }
  for (const listener of listeners) {
    listener();
  }
}

function updateState(updater: (prev: FloatingChatState) => FloatingChatState) {
  const next = updater(currentState);
  // An update that changed nothing is not saved and wakes nobody.
  if (next === currentState) return;
  currentState = next;
  notify();
}

/** The same state with one more request to look at the chat. */
const focused = (state: FloatingChatState): FloatingChatState => ({ ...state, focusRequest: state.focusRequest + 1 });

/**
 * The tab to show when `closed` goes: the one before it, else the one after, so the order the user set up is
 * respected. The docked workspace is already on screen beside it, so it is only chosen when nothing else is left.
 */
function neighbourOf(tabs: readonly string[], closed: string, docked: string | null): string | null {
  const index = tabs.indexOf(closed);
  const others = tabs.map((tab, position) => ({ tab, distance: Math.abs(position - index), position })).filter(({ tab }) => tab !== closed);
  // Nearest to the one closed; at the same distance, the one before it.
  const nearest = others.sort((a, b) => a.distance - b.distance || a.position - b.position);
  return (nearest.find(({ tab }) => tab !== docked) ?? nearest[0])?.tab ?? null;
}

export const floatingChatStore = {
  getState: () => currentState,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  openTerminal: (branchName: string, target = 'shell', sessionId?: string, cwd?: string) => {
    const pending = currentState.terminalLaunches[branchName];
    if (sessionId && pending?.target === target && pending.sessionId === sessionId) {
      floatingChatStore.openCli(branchName);
      return;
    }
    floatingChatStore.open(branchName);
    floatingChatStore.setHarness(branchName, target);
    updateState(prev => ({ ...prev, modes: { ...prev.modes, [branchName]: 'cli' }, terminalLaunches: { ...prev.terminalLaunches, [branchName]: { id: crypto.randomUUID(), target, sessionId, cwd } } }));
  },
  consumeTerminalLaunch: (branchName: string, id: string) => {
    updateState(prev => {
      if (prev.terminalLaunches[branchName]?.id !== id) return prev;
      const terminalLaunches = { ...prev.terminalLaunches }; delete terminalLaunches[branchName];
      return { ...prev, terminalLaunches };
    });
  },
  setMode: (branchName: string, mode: 'cli' | 'chat') => updateState(prev => (prev.modes[branchName] === mode ? prev : { ...prev, modes: { ...prev.modes, [branchName]: mode } })),
  setHarness: (branchName: string, harness: string) => updateState(prev => (prev.harnesses[branchName] === harness ? prev : { ...prev, harnesses: { ...prev.harnesses, [branchName]: harness } })),
  openDraft: (branchName: string, text: string) => {
    floatingChatStore.open(branchName);
    floatingChatStore.setMode(branchName, 'chat');
    updateState((prev) => ({ ...prev, drafts: {
      ...prev.drafts,
      [branchName]: { id: crypto.randomUUID(), text },
    } }));
  },

  consumeDraft: (branchName: string, id: string) => {
    updateState((prev) => {
      if (prev.drafts[branchName]?.id !== id) return prev;
      const drafts = { ...prev.drafts };
      delete drafts[branchName];
      return { ...prev, drafts };
    });
  },

  openCli: (branchName: string) => floatingChatStore.open(branchName, 'cli'),

  /** Opens a workspace's chat as a tab, makes it the active one and asks to see it. */
  open: (branchName?: string, mode?: 'cli' | 'chat') => {
    updateState((prev) => {
      const openTabs = [...prev.openTabs];
      let activeTab = prev.activeTab;

      if (branchName) {
        activeTab = branchName;
      } else if (!activeTab && openTabs.length > 0) {
        activeTab = openTabs[0];
      }

      const nextOpenTabs = activeTab && !openTabs.includes(activeTab) ? [...openTabs, activeTab] : openTabs;

      return focused({
        ...prev,
        openTabs: nextOpenTabs,
        activeTab,
        modes: branchName && mode ? { ...prev.modes, [branchName]: mode } : prev.modes,
        splitTab: activeTab === prev.splitTab ? prev.activeTab : prev.splitTab,
      });
    });
  },

  /**
   * Makes a workspace the active tab because the address says so, adding the tab
   * if it is missing. It does not ask to see the chat: the user is already there.
   */
  reveal: (branchName: string) => {
    updateState((prev) => {
      const present = prev.openTabs.includes(branchName);
      if (present && prev.activeTab === branchName) return prev;
      return {
        ...prev,
        openTabs: present ? prev.openTabs : [...prev.openTabs, branchName],
        activeTab: branchName,
        splitTab: branchName === prev.splitTab ? prev.activeTab : prev.splitTab,
      };
    });
  },

  addTab: (branchName: string) => {
    updateState((prev) => focused({
      ...prev,
      openTabs: prev.openTabs.includes(branchName) ? prev.openTabs : [...prev.openTabs, branchName],
      activeTab: branchName,
      splitTab: branchName === prev.splitTab ? prev.activeTab : prev.splitTab,
    }));
  },

  /** Closes a tab. When it was the one on screen, the next tab takes its place and is asked for. */
  removeTab: (branchName: string) => {
    updateState((prev) => {
      if (!prev.openTabs.includes(branchName)) return prev;
      const openTabs = prev.openTabs.filter((t) => t !== branchName);
      let activeTab = prev.activeTab;
      if (activeTab === branchName) activeTab = neighbourOf(prev.openTabs, branchName, prev.splitTab);
      const next = {
        ...prev,
        openTabs,
        activeTab,
        splitTab: branchName === prev.splitTab || activeTab === prev.splitTab ? null : prev.splitTab,
      };
      return activeTab !== prev.activeTab && activeTab !== null ? focused(next) : next;
    });
  },

  setActiveTab: (branchName: string) => {
    updateState((prev) => {
      if (!prev.openTabs.includes(branchName)) return prev;
      return focused({
        ...prev,
        openTabs: prev.openTabs,
        activeTab: branchName,
        splitTab: branchName === prev.splitTab ? prev.activeTab : prev.splitTab,
      });
    });
  },

  setSplitTab: (branchName: string | null) => {
    updateState(prev => {
      if (branchName === prev.activeTab) return prev;
      const openTabs = branchName && !prev.openTabs.includes(branchName) ? [...prev.openTabs, branchName] : prev.openTabs;
      return { ...prev, openTabs, splitTab: branchName };
    });
  },

  setSplitRatio: (ratio: number) => updateState(prev => ({ ...prev, splitRatio: clampSplitRatio(ratio) })),
};

export function useFloatingChat(): FloatingChatState & typeof floatingChatStore {
  const state = useSyncExternalStore(
    floatingChatStore.subscribe,
    floatingChatStore.getState,
    floatingChatStore.getState,
  );

  return {
    ...state,
    ...floatingChatStore,
  };
}
