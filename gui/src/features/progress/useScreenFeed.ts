import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { EMPTY_FEED, liveFeedHub, type FeedState } from './liveFeedHub.js';

/**
 * The screen events the AI has sent for a workspace, kept while it is on screen. The connection is the workspace's
 * shared one (liveFeedHub), opened while anything is listening, so a strip that starts listening after the Board did
 * still has the events the stream already sent. The stream replays recent events to a connection that opens, and the
 * hub keeps them from there, so nothing is stored here.
 */
export function useScreenFeed(workspace: string, enabled: boolean): FeedState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<FeedState>(EMPTY_FEED);

  useEffect(() => {
    setState(EMPTY_FEED);
    if (!enabled) return;
    return liveFeedHub.subscribe(workspace, queryClient, setState);
  }, [workspace, enabled, queryClient]);

  return state;
}

/**
 * Whether the workspace's live connection is open, listening for as long as `enabled`. For what only needs to know the
 * feed is there, such as the Board, which reads on its own while it is not: it does not re-render for each event.
 */
export function useFeedConnected(workspace: string, enabled: boolean): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(false);
    if (!enabled) return;
    return liveFeedHub.subscribe(workspace, queryClient, (state) => setConnected(state.connected));
  }, [workspace, enabled, queryClient]);

  return connected;
}
