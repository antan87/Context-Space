import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { API_BASE } from '../../lib/apiBase.js';
import { planKey, progressFactsKey } from '../../lib/api/queries.js';
import type { ScreenEvent } from '../../types.js';
import { addScreenEvent, connectScreenFeed } from './screenFeed.js';

/** A burst of events (the replay when a stream opens) asks for one fresh read, not one each. */
const REFRESH_DELAY_MS = 300;

/**
 * The screen events the AI has sent for a workspace, kept while it is on screen.
 * The stream replays recent events when it opens, so nothing is stored here. Any
 * event can change what the strip says, so each one also asks for fresh facts
 * instead of guessing at them.
 */
export function useScreenFeed(workspace: string, enabled: boolean): { events: readonly ScreenEvent[]; connected: boolean } {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ events: readonly ScreenEvent[]; connected: boolean }>({ events: [], connected: false });

  useEffect(() => {
    setState({ events: [], connected: false });
    if (!enabled) return;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const connection = connectScreenFeed({
      url: (since) => `${API_BASE}/api/workspace/${encodeURIComponent(workspace)}/screen-events${since ? `?since=${encodeURIComponent(since)}` : ''}`,
      onLive: (live) => {
        // A plan changed by an AI's CLI or MCP shows at once everywhere it is read, not at the next poll.
        if (live.type === 'plan') {
          for (const queryKey of [planKey(workspace), ['workspace-work', workspace], ['workspace-lifecycle', workspace], ['needs-you']]) {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
        if (live.type === 'screen') {
          setState((current) => {
            const events = addScreenEvent(current.events, live.event);
            return events === current.events ? current : { ...current, events };
          });
        }
        clearTimeout(refresh);
        refresh = setTimeout(() => { void queryClient.invalidateQueries({ queryKey: progressFactsKey(workspace) }); }, REFRESH_DELAY_MS);
      },
      onStatus: (connected) => setState((current) => (current.connected === connected ? current : { ...current, connected })),
    });
    return () => {
      clearTimeout(refresh);
      connection.close();
    };
  }, [workspace, enabled, queryClient]);

  return state;
}
