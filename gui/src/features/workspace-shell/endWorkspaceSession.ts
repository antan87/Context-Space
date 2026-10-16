import { floatingChatStore } from '../chat/floatingChatStore.js';
import { terminalRequest, type TerminalStatus } from '../terminal/client.js';

export interface EndedSession {
  /** Running terminals that were stopped. */
  stopped: number;
  /** Running terminals that could not be stopped, and so may still be running. */
  failed: number;
}

interface Dependencies {
  request: <T>(workspace: string, action: string) => Promise<T>;
  closeTab: (workspace: string) => void;
}

const live: Dependencies = {
  request: (workspace, action) => terminalRequest(workspace, action),
  // The person stays where they are; archiving from here must not take them to another workspace's chat.
  closeTab: (workspace) => floatingChatStore.removeTab(workspace, { follow: false }),
};

/**
 * Ends a workspace's open session: every terminal it has running stops and its tab closes. An archived workspace is a
 * record, and a CLI left running in it would work in a folder that archiving has just cleaned up. The tab closes even
 * when a terminal cannot be stopped, so the caller can say which ones may still be running.
 */
export async function endWorkspaceSession(workspace: string, deps: Dependencies = live): Promise<EndedSession> {
  let running: { id: string }[] = [];
  try {
    running = (await deps.request<TerminalStatus>(workspace, 'status')).sessions.filter((session) => session.state === 'running');
  } catch {
    // The terminal service cannot be reached, so this window has nothing to stop; the tab still closes.
  }
  const results = await Promise.allSettled(running.map((session) => deps.request(workspace, `${session.id}/stop`)));
  deps.closeTab(workspace);
  const failed = results.filter((result) => result.status === 'rejected').length;
  return { stopped: results.length - failed, failed };
}
