/**
 * One live connection per workspace, shared by everything on screen that wants it: the strip above the chat and the
 * Board. The connection is open while anything is subscribed and closed after the last one leaves, so a Board that is
 * shown without the chat, an AI working in another terminal and a chat that is hidden all see changes as they happen.
 *
 * The hub also asks the queries to read again: PLAN.md and what hangs on it when the plan changes, the progress facts
 * after any event, and the board on a board event and whenever the connection (re)opens (the stream replays screen
 * events to a screen that connects, but never board events). It keeps the recent screen events, so a subscriber that
 * arrives after the connection was opened by another one still has them: the stream replays only on first connect.
 * Plain functions over an injected connection, so it is tested with a fake one.
 */

import type { QueryClient } from '@tanstack/react-query';

import { API_BASE } from '../../lib/apiBase.js';
import { progressFactsKey } from '../../lib/api/queries.js';
import type { LiveEvent, ScreenEvent } from '../../types.js';
import { boardKey } from '../board/boardData.js';
import { planFileKey } from '../plan/planFile.js';
import { newsKey } from '../plan/whatsNew.js';
import { addScreenEvent, connectScreenFeed, type ScreenFeedOptions } from './screenFeed.js';

/** A burst of events (the replay when a stream opens) asks for one fresh read, not one each. */
export const REFRESH_DELAY_MS = 300;

/** What a subscriber sees: the screen events kept for the workspace, and whether the connection is open. */
export interface FeedState { events: readonly ScreenEvent[]; connected: boolean }

export const EMPTY_FEED: FeedState = { events: [], connected: false };

export interface LiveFeedHub {
  /**
   * Starts listening for a workspace. `listener` is called at once with what is kept, then with each change. Returns
   * the way to stop; the connection closes when the last subscriber of the workspace has stopped.
   */
  subscribe(workspace: string, queryClient: QueryClient, listener: (state: FeedState) => void): () => void;
}

interface Entry {
  queryClient: QueryClient;
  listeners: Set<(state: FeedState) => void>;
  state: FeedState;
  close: () => void;
  timers: Array<ReturnType<typeof setTimeout> | undefined>;
}

const streamUrl = (workspace: string, since: string | undefined) =>
  `${API_BASE}/api/workspace/${encodeURIComponent(workspace)}/screen-events${since ? `?since=${encodeURIComponent(since)}` : ''}`;

export function createLiveFeedHub(connect: (options: ScreenFeedOptions) => { close: () => void } = connectScreenFeed): LiveFeedHub {
  const entries = new Map<string, Entry>();

  function open(workspace: string, queryClient: QueryClient): Entry {
    const entry: Entry = { queryClient, listeners: new Set(), state: EMPTY_FEED, close: () => {}, timers: [undefined, undefined] };
    const set = (next: FeedState) => {
      if (next === entry.state) return;
      entry.state = next;
      for (const listener of [...entry.listeners]) listener(next);
    };
    const later = (slot: 0 | 1, run: () => void) => {
      clearTimeout(entry.timers[slot]);
      entry.timers[slot] = setTimeout(run, REFRESH_DELAY_MS);
    };
    const invalidate = (queryKey: readonly unknown[]) => { void queryClient.invalidateQueries({ queryKey }); };

    entry.close = connect({
      url: (since) => streamUrl(workspace, since),
      onLive: (live: LiveEvent) => {
        if (live.type === 'board') {
          // An AI that arranges the board sends a burst of changes; they are read together. A board event says nothing the
          // strip shows, so it does not ask for fresh progress facts.
          later(0, () => invalidate(boardKey(workspace)));
          return;
        }
        // PLAN.md changed by an AI's own edit or the CLI shows at once everywhere it is read, not at the next poll.
        if (live.type === 'plan') {
          for (const queryKey of [planFileKey(workspace), newsKey(workspace), ['workspace-work', workspace], ['workspace-lifecycle', workspace], ['needs-you']]) invalidate(queryKey);
        }
        if (live.type === 'screen') {
          const events = addScreenEvent(entry.state.events, live.event);
          if (events !== entry.state.events) set({ ...entry.state, events });
        }
        // Any event can change what the strip says, so it asks for fresh facts instead of guessing at them.
        later(1, () => invalidate(progressFactsKey(workspace)));
      },
      onStatus: (connected) => {
        if (entry.state.connected !== connected) set({ ...entry.state, connected });
        // Board events sent while the stream was down are gone for good, so a (re)connected stream reads the board itself.
        if (connected) invalidate(boardKey(workspace));
      },
    }).close;
    return entry;
  }

  return {
    subscribe(workspace, queryClient, listener) {
      const entry = entries.get(workspace) ?? open(workspace, queryClient);
      entries.set(workspace, entry);
      entry.listeners.add(listener);
      listener(entry.state);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        // The last one has gone: what was kept goes with the connection, as the stream replays it to the next one.
        for (const timer of entry.timers) clearTimeout(timer);
        entry.close();
        if (entries.get(workspace) === entry) entries.delete(workspace);
      };
    },
  };
}

/** The hub the app uses. */
export const liveFeedHub = createLiveFeedHub();
