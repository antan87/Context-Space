import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { floatingChatStore } from '../chat/floatingChatStore.js';
import { browserPath, goToWorkspace } from '../chat/chatRoute.js';
import { resolveWorkspaceShortcut } from './sessionShortcuts.js';

/**
 * Registers the global keys for moving between open workspace sessions (see `sessionShortcuts.ts`). The sidebar's
 * marker moving to the session is the confirmation, so nothing else is shown.
 */
export function useWorkspaceShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // One step for one press: a held key must not run through every session, or add a history entry for each, and a
      // key that belongs to an input method is not ours.
      if (event.repeat || event.isComposing) return;
      const { openTabs, activeTab } = floatingChatStore.getState();
      const resolved = resolveWorkspaceShortcut({
        event,
        openTabs,
        activeTab,
        // The address as it is now, not as the page last rendered it: a key pressed straight after another must see where
        // the first one went.
        pathname: browserPath(),
      });

      if (resolved) {
        event.preventDefault();
        event.stopPropagation();
        floatingChatStore.reveal(resolved.targetBranch);
        const targetSection = resolved.targetSection === 'plan' ? 'board' : resolved.targetSection;
        goToWorkspace(navigate, resolved.targetBranch, targetSection);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);
}
