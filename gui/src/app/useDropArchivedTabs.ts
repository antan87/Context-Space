import { useEffect } from 'react';
import { floatingChatStore } from '../features/chat/floatingChatStore.js';
import type { Feature } from '../types.js';
import { archivedTabs } from './workspaceList.js';

/**
 * An archived workspace is a record and has no session. Archiving here closes its tab, but a workspace archived from the
 * command line, from another window, or before this window was reloaded can still have one, and the Alt keys and the
 * neighbour choice on closing a tab would take the person to its record. Its tab is closed wherever the list shows it archived.
 */
export function useDropArchivedTabs(workspaces: readonly Pick<Feature, 'archivedAt' | 'branchName' | 'id'>[]) {
  useEffect(() => {
    const drop = () => {
      for (const tab of archivedTabs(floatingChatStore.getState().openTabs, workspaces)) floatingChatStore.removeTab(tab, { follow: false });
    };
    drop();
    const unsubscribe = floatingChatStore.subscribe(drop);
    return () => { unsubscribe(); };
  }, [workspaces]);
}
