import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { floatingChatStore } from '../chat/floatingChatStore.js';
import { WORKING_WINDOW_MS } from '../chat/liveSessions.js';
import { useRunningTerminals } from '../chat/useRunningTerminals.js';
import { terminalRequest, type TerminalStatus } from '../terminal/client.js';
import { useWorkspaceSessionSources } from '../terminal/useWorkspaceSessionSources.js';
import { defaultTool, rankTools, readToolUse, rememberToolStarted } from './toolPrefs.js';
import type { AISession } from '../../types.js';

/**
 * A workspace's sessions as the home shows them: the tools that can start, the terminals running now, and the saved
 * conversations to continue. Starting, continuing or showing one switches to the session's tab.
 */
export function useWorkspaceSessions(workspace: string, enabled = true) {
  const navigate = useNavigate();
  const [use, setUse] = useState(readToolUse);
  // Shared with the session tabs, which read the same list.
  const status = useQuery({
    queryKey: ['terminal-status', workspace],
    queryFn: () => terminalRequest<TerminalStatus>(workspace, 'status'),
    enabled,
    staleTime: 2000,
    retry: 1,
  });
  const running = useRunningTerminals();
  const saved = useWorkspaceSessionSources(workspace, enabled);

  const available = useMemo(() => (status.data?.available ? status.data.targets.filter((target) => target.available).map((target) => target.id) : []), [status.data]);
  const tools = useMemo(() => rankTools(available, use), [available, use]);
  const lastTool = defaultTool(available, use);
  // Working means output within the last few seconds of the list's own reading, so a render never reads the clock.
  const readAt = running.dataUpdatedAt;
  const runningHere = (running.data ?? []).filter((terminal) => terminal.workspace === workspace && terminal.state === 'running' && terminal.target !== 'shell')
    .map((terminal) => {
      const output = Date.parse(terminal.lastOutputAt ?? '');
      return { ...terminal, working: readAt > 0 && Number.isFinite(output) && readAt - output <= WORKING_WINDOW_MS };
    });
  const recent = saved.sessions.filter((session) => session.threadKind !== 'subagent' && session.recordedCwd)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));

  const toChat = useCallback(() => navigate(`/workspaces/${encodeURIComponent(workspace)}/chat`), [navigate, workspace]);
  const start = useCallback((tool: string, prompt?: string) => {
    setUse(rememberToolStarted(tool));
    floatingChatStore.openTerminal(workspace, tool, undefined, undefined, prompt);
    toChat();
  }, [workspace, toChat]);
  const resume = useCallback((session: AISession) => {
    floatingChatStore.openTerminal(workspace, session.assistant, session.id, session.workspacePath);
    toChat();
  }, [workspace, toChat]);
  const show = useCallback((terminalId: string, target: string) => {
    floatingChatStore.showTerminal(workspace, terminalId, target);
    toChat();
  }, [workspace, toChat]);

  return {
    loading: status.isPending, unavailable: status.data ? !status.data.available : false, reason: status.data?.reason,
    tools, lastTool, running: runningHere, recent, savedLoading: saved.sourcesPending > 0, savedCount: recent.length,
    start, resume, show,
  };
}
