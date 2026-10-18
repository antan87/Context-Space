import { SessionActivity } from './SessionActivity.js';
import { SessionKind, mainSessionFor } from './SessionKind.js';
import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  MessageSquare,
  Terminal,
  Search,
  ArrowUpDown,
  Check,
} from 'lucide-react';
import { BsOpenai } from 'react-icons/bs';
import { SiClaude, SiGithubcopilot } from 'react-icons/si';
import { AntigravityIcon } from '../../components/icons/AntigravityIcon.js';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';

import type { AISession, Feature, TranscriptMessage } from '../../types.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { Spinner } from '../../components/ui/spinner.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { useWorkspaceLaunchTargets, useLaunchTerminal, useAiDetect } from '../../lib/api/queries.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { apiFetch } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import { formatCompact, formatHeaderQuota } from './usageFormat.js';
import { handleDelegatedRowClick, handleDelegatedRowKeyDown } from '../../lib/delegatedRowClick.js';
import { isTypingTarget } from '../../app/typingTarget.js';

export type SessionSortOption =
  | 'created-desc'
  | 'created-asc'
  | 'updated-desc'
  | 'messages-desc'
  | 'title-asc';

export type SessionViewMode = 'harness' | 'timeline';

interface SessionHistoryProps {
  ws: Feature;
  sessions: AISession[];
  sessionsLoading: boolean;
  setActiveSession: (val: AISession | null) => void;
  setTranscript: (val: TranscriptMessage[]) => void;
  fetchSessionTranscript: (assistant: string, sessionId: string) => Promise<void>;
  handleOpenDesktopSession: (ws: Feature, sessionId: string, assistant: string) => Promise<boolean>;
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
  initialSearch?: string;
  initialViewMode?: SessionViewMode;
}

export function matchesSessionQuery(
  session: AISession,
  query: string,
  harness?: { name?: string; cliCommand?: string }
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const ast = session.assistant?.toLowerCase() ?? '';
  const vendorAliases = ast === 'antigravity'
    ? 'google antigravity agy'
    : ast === 'claude'
    ? 'claude code anthropic'
    : ast === 'codex'
    ? 'openai codex'
    : ast === 'copilot'
    ? 'github copilot microsoft'
    : ast;

  const hName = harness?.name?.toLowerCase() ?? '';
  const hCli = harness?.cliCommand?.toLowerCase() ?? '';
  const knownHarnessName = harnessName(session.assistant).toLowerCase();

  const title = (session.title ?? '').toLowerCase();
  const id = (session.id ?? '').toLowerCase();

  const hay = `${title} ${id} ${ast} ${vendorAliases} ${knownHarnessName} ${hName} ${hCli}`;
  return hay.includes(q);
}

const getResumeCliCommand = (assistant: string, sessionId: string): string => {
  switch (assistant) {
    case 'antigravity':
      return `agy --conversation ${sessionId}`;
    case 'claude':
      return `claude --resume ${sessionId}`;
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'copilot':
      return `copilot --resume ${sessionId}`;
    case 'cursor':
      return `cursor-agent --resume ${sessionId}`;
    case 'pi':
      return `pi --session ${sessionId}`;
    default:
      return `agy --conversation ${sessionId}`;
  }
};

const renderAssistantIcon = (ast: string) => {
  switch (ast) {
    case 'antigravity':
      return (
        <span className="grid size-5.5 place-items-center rounded-md bg-card border border-border/80 shadow-2xs p-0.5 shrink-0" title="Google Antigravity">
          <AntigravityIcon className="size-3.5" />
        </span>
      );
    case 'claude':
      return (
        <span className="grid size-5.5 place-items-center rounded-md bg-[#D97757] text-white font-bold text-[9px] shadow-2xs shrink-0" title="Claude Code">
          <SiClaude className="size-2.5" />
        </span>
      );
    case 'codex':
      return (
        <span className="grid size-5.5 place-items-center rounded-md bg-foreground text-background font-bold text-[9px] shadow-2xs shrink-0" title="OpenAI Codex">
          <BsOpenai className="size-2.5" />
        </span>
      );
    case 'copilot':
      return (
        <span className="grid size-5.5 place-items-center rounded-md bg-gradient-to-tr from-purple-600 via-indigo-500 to-blue-600 text-white font-bold text-[9px] shadow-2xs shrink-0" title="GitHub Copilot">
          <SiGithubcopilot className="size-2.5" />
        </span>
      );
    case 'pi':
      return (
        <span className="grid size-5.5 place-items-center rounded-md bg-muted border border-border/80 shadow-2xs p-0.5 shrink-0" title="Pi">
          <HarnessIcon harness="pi" className="size-3.5" />
        </span>
      );
    default:
      return null;
  }
};

export const SessionHistory: React.FC<SessionHistoryProps> = ({
  ws,
  sessions: allSessions,
  sessionsLoading,
  setActiveSession,
  setTranscript,
  fetchSessionTranscript,
  handleOpenDesktopSession,
  showToast,
  initialSearch = '',
  initialViewMode = 'harness',
}) => {
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const sessions = useMemo(() => allSessions.filter(s => includeSubagents || s.threadKind !== 'subagent'), [allSessions, includeSubagents]);
  const hiddenSubagents = allSessions.filter(s => s.threadKind === 'subagent').length;
  const launchTargets = useWorkspaceLaunchTargets();
  const launchTerminalMutation = useLaunchTerminal();
  const aiDetect = useAiDetect();

  const isAgyDetected = aiDetect.data?.find((a) => a.name === 'antigravity')?.detected ?? true;
  const isClaudeDetected = Boolean(aiDetect.data?.find((a) => a.name === 'claude')?.detected);
  const isCodexDetected = Boolean(aiDetect.data?.find((a) => a.name === 'codex')?.detected);
  const isCopilotDetected = Boolean(aiDetect.data?.find((a) => a.name === 'copilot')?.command);
  const isPiDetected = Boolean(aiDetect.data?.find((a) => a.name === 'pi')?.detected);

  const hasAgyIde = Boolean(launchTargets.data?.some((t) => t.id === 'antigravity' && t.available));
  const hasCodexDesktop = Boolean(launchTargets.data?.some((t) => t.id === 'codex-desktop' && t.available));

  const [openingDesktopId, setOpeningDesktopId] = useState<string | null>(null);
  const [resumingTerminalId, setResumingTerminalId] = useState<string | null>(null);
  const [launchedInfo, setLaunchedInfo] = useState<{ assistant: string; cmd: string; timestamp: Date } | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [hudCopied, setHudCopied] = useState(false);
  const hudTimeoutRef = useRef<number | null>(null);

  // Sorting & Filtering state
  const [sortBy, setSortBy] = useState<SessionSortOption>('updated-desc');
  const [viewMode, setViewMode] = useState<SessionViewMode>(initialViewMode);
  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [selectedAssistantFilter, setSelectedAssistantFilter] = useState<string>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Preserve user harness expansion state across search queries
  const [expandedHarnesses, setExpandedHarnesses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'Escape' && !isTypingTarget(e.target) && searchQuery) {
        e.preventDefault();
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  useEffect(() => {
    return () => {
      if (hudTimeoutRef.current) clearTimeout(hudTimeoutRef.current);
    };
  }, []);

  const toggleHarness = (id: string, currentlyExpanded: boolean) => {
    setExpandedHarnesses((prev) => ({ ...prev, [id]: !currentlyExpanded }));
  };

  const openingDesktopRef = useRef<string | null>(null);

  const openAppTarget = async (targetId: string) => {
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(ws.branchName)}/launch`, {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
      const name = targetId === 'claude-desktop' ? 'Claude Desktop' : targetId === 'codex-desktop' ? 'Codex Desktop' : targetId;
      showToast?.(`Launched ${name} for workspace ${ws.branchName}`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to launch desktop application';
      showToast?.(message, 'error');
    }
  };


  const resumeTerminalSession = async (sessionId: string, assistant: string, sessionCwd?: string) => {
    if (resumingTerminalId) return;
    setResumingTerminalId(sessionId);
    try {
      await launchTerminalMutation.mutateAsync({
        workspaceId: ws.branchName,
        sessionId,
        assistant,
        cwd: sessionCwd,
      });
      const cmd = getResumeCliCommand(assistant, sessionId);
      setLaunchedInfo({
        assistant,
        cmd,
        timestamp: new Date(),
      });
      // The CLI chat window performs the launch and reports its own failures.
      showToast?.(`Opening ${assistant} in CLI chat…`, 'info');
    } catch {
      const fallbackCmd = getResumeCliCommand(assistant, sessionId);
      await safeCopyToClipboard(fallbackCmd);
      showToast?.(`Copied resume command to clipboard: ${fallbackCmd}`, 'info');
    } finally {
      setResumingTerminalId(null);
    }
  };

  const openCodexDesktop = async (sessionId: string) => {
    if (!hasCodexDesktop || openingDesktopRef.current) return;
    openingDesktopRef.current = sessionId;
    setOpeningDesktopId(sessionId);
    try {
      await handleOpenDesktopSession(ws, sessionId, 'codex');
    } finally {
      openingDesktopRef.current = null;
      setOpeningDesktopId(null);
    }
  };

  // Sort comparator function
  const sortSessions = (sessionList: AISession[], order: SessionSortOption): AISession[] => {
    return [...sessionList].sort((a, b) => {
      switch (order) {
        case 'created-desc': {
          const aTime = new Date(a.createdAt || a.updatedAt || 0).getTime();
          const bTime = new Date(b.createdAt || b.updatedAt || 0).getTime();
          return bTime - aTime;
        }
        case 'created-asc': {
          const aTime = new Date(a.createdAt || a.updatedAt || 0).getTime();
          const bTime = new Date(b.createdAt || b.updatedAt || 0).getTime();
          return aTime - bTime;
        }
        case 'updated-desc': {
          const aTime = (Date.parse(a.updatedAt) || 0);
          const bTime = (Date.parse(b.updatedAt) || 0);
          return bTime - aTime;
        }
        case 'messages-desc': {
          return (b.messageCount || 0) - (a.messageCount || 0);
        }
        case 'title-asc': {
          return (a.title || '').localeCompare(b.title || '');
        }
        default:
          return 0;
      }
    });
  };

  // Filtered & sorted master list
  const filteredSessions = useMemo(() => {
    let list = sessions;
    if (selectedAssistantFilter !== 'all') {
      list = list.filter((s) => s.assistant === selectedAssistantFilter);
    }
    if (searchQuery.trim()) {
      list = list.filter((s) => matchesSessionQuery(s, searchQuery));
    }
    return sortSessions(list, sortBy);
  }, [sessions, selectedAssistantFilter, searchQuery, sortBy]);

  // Group sessions by assistant with sorting applied
  const agySessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.assistant === 'antigravity'), sortBy),
    [sessions, sortBy]
  );
  const claudeSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.assistant === 'claude'), sortBy),
    [sessions, sortBy]
  );
  const codexSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.assistant === 'codex'), sortBy),
    [sessions, sortBy]
  );
  const copilotSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.assistant === 'copilot'), sortBy),
    [sessions, sortBy]
  );
  const piSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.assistant === 'pi'), sortBy),
    [sessions, sortBy]
  );

  const isAssistantConfigured = useCallback((id: string) => ws.assistants?.includes(id) ?? false, [ws.assistants]);

  const allHarnesses = useMemo(() => [
    {
      id: 'antigravity',
      name: 'Google Antigravity',
      cliCommand: 'agy',
      isDetected: isAgyDetected,
      isConfigured: isAssistantConfigured('antigravity'),
      hasApp: hasAgyIde,
      appName: 'IDE',
      appTargetId: 'antigravity',
      sessions: agySessions,
      icon: (
        <span className="grid size-6 place-items-center rounded-md bg-card border border-border/80 shadow-2xs p-0.5">
          <AntigravityIcon className="size-4" />
        </span>
      ),
    },
    {
      id: 'claude',
      name: 'Claude Code',
      cliCommand: 'claude',
      isDetected: isClaudeDetected,
      isConfigured: isAssistantConfigured('claude'),
      hasApp: false,
      appName: 'App',
      appTargetId: 'claude',
      sessions: claudeSessions,
      icon: (
        <span className="grid size-6 place-items-center rounded-md bg-[#D97757] text-white font-bold text-[10px] shadow-2xs">
          <SiClaude className="size-3" />
        </span>
      ),
    },
    {
      id: 'codex',
      name: 'OpenAI Codex',
      cliCommand: 'codex',
      isDetected: isCodexDetected,
      isConfigured: isAssistantConfigured('codex'),
      hasApp: hasCodexDesktop,
      appName: 'Desktop',
      appTargetId: 'codex-desktop',
      sessions: codexSessions,
      icon: (
        <span className="grid size-6 place-items-center rounded-md bg-foreground text-background font-bold text-[10px] shadow-2xs">
          <BsOpenai className="size-3" />
        </span>
      ),
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot',
      cliCommand: 'copilot',
      isDetected: isCopilotDetected,
      isConfigured: isAssistantConfigured('copilot'),
      hasApp: false,
      appName: 'App',
      appTargetId: 'copilot',
      sessions: copilotSessions,
      icon: (
        <span className="grid size-6 place-items-center rounded-md bg-gradient-to-tr from-purple-600 via-indigo-500 to-blue-600 text-white font-bold text-[10px] shadow-2xs">
          <SiGithubcopilot className="size-3" />
        </span>
      ),
    },
    {
      id: 'pi',
      name: 'Pi',
      cliCommand: 'pi',
      isDetected: isPiDetected,
      isConfigured: isAssistantConfigured('pi'),
      hasApp: false,
      appName: 'App',
      appTargetId: 'pi',
      sessions: piSessions,
      icon: (
        <span className="grid size-6 place-items-center rounded-md bg-muted border border-border/80 shadow-2xs p-0.5">
          <HarnessIcon harness="pi" className="size-4" />
        </span>
      ),
    },
  ], [
    isAgyDetected, isClaudeDetected, isCodexDetected, isCopilotDetected, isPiDetected,
    hasAgyIde, hasCodexDesktop, isAssistantConfigured,
    agySessions, claudeSessions, codexSessions, copilotSessions, piSessions,
  ]);

  const installedHarnesses = useMemo(() => {
    return allHarnesses.filter((h) => h.isDetected || h.sessions.length > 0);
  }, [allHarnesses]);

  const visibleHarnesses = useMemo(() => {
    let list = installedHarnesses;
    if (selectedAssistantFilter !== 'all') {
      list = list.filter((h) => h.id === selectedAssistantFilter);
    }
    return list;
  }, [installedHarnesses, selectedAssistantFilter]);

  const sortLabelMap: Record<SessionSortOption, string> = {
    'created-desc': 'Newest',
    'created-asc': 'Oldest',
    'updated-desc': 'Recently active',
    'messages-desc': 'Most turns',
    'title-asc': 'A–Z',
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Discovery reads local assistant history. Resuming a session uses that assistant’s provider settings. <Link className="underline" to="/settings#data-and-privacy">Storage, sharing and deletion controls</Link>.</p>
      {/* Search, Filter & Sort Order Toolbar */}
      <div className="flex flex-col gap-2 bg-card/60 p-2 rounded-md border border-border/80">
        <div className="flex flex-col gap-2 min-w-0">
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none z-10" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (searchQuery) {
                    setSearchQuery('');
                  } else {
                    searchInputRef.current?.blur();
                  }
                }
              }}
              placeholder="Search chat sessions... (/)"
              className="w-full pl-7 pr-6 py-1 text-xs rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-[10px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ✕
              </button>
            )}
          </div>

          {/* Assistant Filter Pills */}
          <div className="hidden md:flex flex-wrap items-center gap-1 min-w-0 w-full">
            <button
              type="button"
              onClick={() => setSelectedAssistantFilter('all')}
              className={cn(
                'px-2 py-0.5 text-[11px] rounded font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                selectedAssistantFilter === 'all'
                  ? 'bg-primary text-primary-foreground font-semibold shadow-2xs'
                  : 'bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              All ({searchQuery.trim() ? filteredSessions.length : sessions.length})
            </button>
            {installedHarnesses.map((harness) => {
              const count = searchQuery.trim()
                ? harness.sessions.filter((s) => matchesSessionQuery(s, searchQuery, harness)).length
                : harness.sessions.length;
              return (
                <button
                  type="button"
                  key={harness.id}
                  onClick={() => setSelectedAssistantFilter(selectedAssistantFilter === harness.id ? 'all' : harness.id)}
                  className={cn(
                    'px-2 py-0.5 text-[11px] rounded font-medium capitalize transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                    selectedAssistantFilter === harness.id
                      ? 'bg-primary text-primary-foreground font-semibold shadow-2xs'
                      : 'bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                >
                  {harness.name.replace('Google ', '').replace('OpenAI ', '').replace('GitHub ', '')} ({count})
                </button>
              );
            })}
          </div>

          {sessionsLoading && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 pl-1">
              <Spinner className="size-3" />
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Order / Sort Dropdown Menu with Base UI */}
          <Menu>
            <MenuTrigger className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border border-border bg-card text-foreground hover:bg-accent cursor-pointer shadow-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              <ArrowUpDown size={11} className="text-muted-foreground" />
              <span>{sortLabelMap[sortBy]}</span>
              <ChevronDown size={10} className="text-muted-foreground opacity-70" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-48">
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Order Chats By
              </div>
              <MenuItem onClick={() => setSortBy('created-desc')} className="flex items-center justify-between text-xs">
                <span>Newest created</span>
                {sortBy === 'created-desc' && <Check size={12} className="text-primary" />}
              </MenuItem>
              <MenuItem onClick={() => setSortBy('created-asc')} className="flex items-center justify-between text-xs">
                <span>Oldest created</span>
                {sortBy === 'created-asc' && <Check size={12} className="text-primary" />}
              </MenuItem>
              <MenuItem onClick={() => setSortBy('updated-desc')} className="flex items-center justify-between text-xs">
                <span>Recently active</span>
                {sortBy === 'updated-desc' && <Check size={12} className="text-primary" />}
              </MenuItem>
              <MenuItem onClick={() => setSortBy('messages-desc')} className="flex items-center justify-between text-xs">
                <span>Most turns</span>
                {sortBy === 'messages-desc' && <Check size={12} className="text-primary" />}
              </MenuItem>
              <MenuItem onClick={() => setSortBy('title-asc')} className="flex items-center justify-between text-xs">
                <span>Title (A–Z)</span>
                {sortBy === 'title-asc' && <Check size={12} className="text-primary" />}
              </MenuItem>
            </MenuPopup>
          </Menu>

          {/* View Mode Toggle: Grouped vs Timeline */}
          <div className="flex items-center rounded border border-border bg-card p-0.5 shadow-2xs">
            <button
              type="button"
              onClick={() => setViewMode('harness')}
              title="Group chats by AI Harness"
              className={cn(
                'px-2 py-0.5 text-xs rounded font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                viewMode === 'harness' ? 'bg-primary text-primary-foreground font-semibold shadow-2xs' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Grouped
            </button>
            <button
              type="button"
              onClick={() => setViewMode('timeline')}
              title="Unified Chronological Timeline"
              className={cn(
                'px-2 py-0.5 text-xs rounded font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                viewMode === 'timeline' ? 'bg-primary text-primary-foreground font-semibold shadow-2xs' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Timeline
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>Main threads are your conversations. Subagents are delegated tasks that report back to them.</p>
        <label className="flex items-center gap-1"><input type="checkbox" checked={includeSubagents} onChange={e => setIncludeSubagents(e.target.checked)} />Include subagent sessions{hiddenSubagents ? ` (${hiddenSubagents})` : ''}</label>
      </div>

      {/* Live Session HUD Banner */}
      {launchedInfo && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-2.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-xs animate-fade-in">
          <div className="flex items-center gap-2 text-foreground min-w-0">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="truncate">
              <strong>Opened in ContextSpace:</strong>{' '}
              <code className="font-mono bg-background/80 px-1.5 py-0.5 rounded text-success-foreground">
                {launchedInfo.cmd}
              </code>
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={async () => {
                await safeCopyToClipboard(launchedInfo.cmd);
                setHudCopied(true);
                if (hudTimeoutRef.current) clearTimeout(hudTimeoutRef.current);
                hudTimeoutRef.current = window.setTimeout(() => setHudCopied(false), 1500);
                showToast?.('Command copied to clipboard!', 'success');
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-emerald-500/40 bg-emerald-500/15 text-success-foreground hover:bg-emerald-500/25 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              {hudCopied ? <Check size={11} className="text-success" /> : <Copy size={11} />} {hudCopied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              aria-label="Dismiss banner"
              onClick={() => setLaunchedInfo(null)}
              className="rounded-sm p-1 -m-1 text-muted-foreground hover:text-foreground cursor-pointer text-xs px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              title="Dismiss banner"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Timeline View (Unified sorted list across all harnesses) */}
      {viewMode === 'timeline' ? (
        <Card className="divide-y divide-border overflow-hidden surface-card">
          {filteredSessions.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {searchQuery ? 'No chat sessions match your search filter.' : 'No chat sessions recorded yet.'}
            </div>
          ) : (
            filteredSessions.map((sess) => {
              const main = mainSessionFor(sess, allSessions);
              const canResume = Boolean(main && !resumingTerminalId);
              const handleResume = () => {
                if (main && !resumingTerminalId) {
                  void resumeTerminalSession(main.id, main.assistant, main.workspacePath);
                }
              };
              return (
                <div
                  key={sess.id}
                  role={canResume ? 'button' : undefined}
                  tabIndex={canResume ? 0 : undefined}
                  onClick={(e) => canResume && handleDelegatedRowClick(e, handleResume)}
                  onKeyDown={(e) => canResume && handleDelegatedRowKeyDown(e, handleResume)}
                  className={cn(
                    'group flex flex-col gap-2 p-3 transition-colors sm:flex-row sm:items-center sm:justify-between select-text',
                    canResume && 'hover:bg-accent/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {renderAssistantIcon(sess.assistant)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5">
                        <span className="font-semibold capitalize text-foreground">
                          {sess.assistant === 'antigravity' ? 'Antigravity' : sess.assistant === 'claude' ? 'Claude' : sess.assistant === 'codex' ? 'Codex' : sess.assistant === 'pi' ? 'Pi' : sess.assistant === 'cursor' ? 'Cursor' : 'Copilot'}
                        </span>
                        <span>•</span>
                        <span className="font-mono text-muted-foreground">{sess.id.slice(0, 8)}</span><SessionKind session={sess} />
                        <span>•</span>
                        <SessionActivity session={sess} />
                        <span>•</span>
                        <span className="font-mono">
                          {sess.messageCount} {sess.messageCount === 1 ? 'turn' : 'turns'}
                        </span>
                        {sess.usage && ((sess.usage.totalTokens ?? 0) > 0 || (sess.usage.inputTokens ?? 0) + (sess.usage.outputTokens ?? 0) > 0) && (
                          <>
                            <span>•</span>
                            <span
                              className="font-mono text-muted-foreground"
                              title={`Input: ${(sess.usage.inputTokens ?? 0).toLocaleString()} (${(sess.usage.cachedInputTokens ?? 0).toLocaleString()} cached) · Output: ${(sess.usage.outputTokens ?? 0).toLocaleString()}`}
                            >
                              {formatCompact(sess.usage.totalTokens ?? ((sess.usage.inputTokens ?? 0) + (sess.usage.outputTokens ?? 0)))} tokens
                            </span>
                          </>
                        )}
                        {sess.quota && (
                          <>
                            <span>•</span>
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted/60 text-muted-foreground border border-border/40">
                              {formatHeaderQuota(sess.quota)}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-xs font-semibold text-foreground truncate" title={sess.title}>
                        {sess.title}
                      </p>
                    </div>
                  </div>

                  {/* Sleek Balanced Action Toolbar */}
                  <div className="flex items-center gap-1.5 shrink-0 pl-8 sm:pl-0">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={resumingTerminalId === sess.id || !mainSessionFor(sess, allSessions)}
                      onClick={() => { const main = mainSessionFor(sess, allSessions); if (main) void resumeTerminalSession(main.id, main.assistant, main.workspacePath); }}
                      title={sess.threadKind === 'subagent' ? 'Resume the main conversation instead of the delegated task' : `Resume session in terminal (${sess.id})`}
                    >
                      {resumingTerminalId === sess.id ? <Spinner className="size-3" /> : <Terminal size={12} />}
                      <span>{sess.threadKind === 'subagent' ? 'Main thread' : 'Resume'}</span>
                    </Button>

                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setActiveSession(sess);
                        setTranscript([]);
                        fetchSessionTranscript(sess.assistant, sess.id);
                      }}
                      title="Inspect transcript log"
                    >
                      <MessageSquare size={12} />
                      <span>Logs</span>
                    </Button>

                    {sess.assistant === 'codex' && hasCodexDesktop && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={openingDesktopId === sess.id}
                        onClick={() => void openCodexDesktop(sess.id)}
                        title="Open in Codex Desktop"
                      >
                        {openingDesktopId === sess.id ? <Spinner className="size-3" /> : <ExternalLink size={12} />}
                        <span>Desktop</span>
                      </Button>
                    )}

                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const cmd = getResumeCliCommand(sess.assistant, sess.id);
                        await safeCopyToClipboard(cmd);
                        setCopiedSessionId(sess.id);
                        setTimeout(() => setCopiedSessionId((id) => (id === sess.id ? null : id)), 1500);
                        showToast?.(`Copied: ${cmd}`, 'success');
                      }}
                      title={copiedSessionId === sess.id ? 'Copied CLI resume command' : 'Copy CLI resume command'}
                    >
                      {copiedSessionId === sess.id ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </Card>
      ) : (
        /* Grouped View (By Harness - Clean Flat Divided Card) */
        <div className="space-y-2.5">
          {searchQuery.trim() && visibleHarnesses.every((harness) => {
            return !harness.sessions.some((s) => matchesSessionQuery(s, searchQuery, harness));
          }) ? (
            <Card className="py-8 text-center text-xs text-muted-foreground surface-card">
              No chat sessions match your search filter.
            </Card>
          ) : (
            visibleHarnesses
              .filter((harness) => {
                if (!searchQuery.trim()) return true;
                return harness.sessions.some((s) => matchesSessionQuery(s, searchQuery, harness));
              })
              .map((harness) => {
                const harnessSessions = harness.sessions.filter((s) => {
                  return matchesSessionQuery(s, searchQuery, harness);
                });
                const isExpanded = expandedHarnesses[harness.id] !== undefined
                  ? expandedHarnesses[harness.id]
                  : Boolean(searchQuery.trim()) && harnessSessions.length > 0;

                return (
                  <Card key={harness.id} className="overflow-hidden surface-card">
                    {/* Sleek Minimal Harness Header Bar */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleHarness(harness.id, isExpanded)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleHarness(harness.id, isExpanded);
                        }
                      }}
                      aria-expanded={isExpanded}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between bg-muted/20 hover:bg-muted/35 transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      <div className="flex flex-1 items-center gap-2.5 min-w-0">
                        <span className="text-muted-foreground transition-transform">
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>

                        {harness.icon}

                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="font-bold text-xs text-foreground">{harness.name}</span>

                          <StatusBadge tone={harness.isDetected ? 'success' : 'neutral'} dot={harness.isDetected}>
                            CLI: {harness.cliCommand}
                          </StatusBadge>

                          {harness.hasApp && (
                            <StatusBadge tone="running">
                              {harness.appName}
                            </StatusBadge>
                          )}

                          <span className="text-[11px] text-muted-foreground font-mono">
                            ({harnessSessions.length})
                          </span>
                        </div>
                      </div>

                      {/* Uniform, Sleek Header Action Buttons */}
                      <div className="flex items-center gap-1.5 shrink-0 pl-6 sm:pl-0" onClick={(e) => e.stopPropagation()}>

                        {harness.hasApp && (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void openAppTarget(harness.appTargetId)}
                            title={`Open in ${harness.appName}`}
                          >
                            <ExternalLink size={12} />
                            <span>{harness.appName}</span>
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Expanded Session Rows (Flat Divided List) */}
                    {isExpanded && (
                      <div className="divide-y divide-border/60 border-t border-border">
                        {harnessSessions.length === 0 ? (
                          <div className="p-4 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                            <span>
                              {searchQuery.trim() ? 'No sessions match your search query.' : `No previous sessions recorded for ${harness.name}.`}
                            </span>
                          </div>
                        ) : (
                      harnessSessions.map((sess) => {
                        const main = mainSessionFor(sess, allSessions);
                        const canResume = Boolean(main && !resumingTerminalId);
                        const handleResume = () => {
                          if (main && !resumingTerminalId) {
                            void resumeTerminalSession(main.id, main.assistant, main.workspacePath);
                          }
                        };
                        return (
                        <div
                          key={sess.id}
                          role={canResume ? 'button' : undefined}
                          tabIndex={canResume ? 0 : undefined}
                          onClick={(e) => canResume && handleDelegatedRowClick(e, handleResume)}
                          onKeyDown={(e) => canResume && handleDelegatedRowKeyDown(e, handleResume)}
                          className={cn(
                            'group flex flex-col gap-1.5 px-3.5 py-2.5 transition-colors sm:flex-row sm:items-center sm:justify-between select-text',
                            canResume && 'hover:bg-accent/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5 mb-0.5 text-[11px] text-muted-foreground font-mono">
                              <span>{sess.id.slice(0, 8)}</span><SessionKind session={sess} />
                              <span>•</span>
                              <SessionActivity session={sess} />
                              <span>•</span>
                              <span>
                                {sess.messageCount} {sess.messageCount === 1 ? 'turn' : 'turns'}
                              </span>
                              {sess.usage && ((sess.usage.totalTokens ?? 0) > 0 || (sess.usage.inputTokens ?? 0) + (sess.usage.outputTokens ?? 0) > 0) && (
                                <>
                                  <span>•</span>
                                  <span
                                    className="text-muted-foreground"
                                    title={`Input: ${(sess.usage.inputTokens ?? 0).toLocaleString()} (${(sess.usage.cachedInputTokens ?? 0).toLocaleString()} cached) · Output: ${(sess.usage.outputTokens ?? 0).toLocaleString()}`}
                                  >
                                    {formatCompact(sess.usage.totalTokens ?? ((sess.usage.inputTokens ?? 0) + (sess.usage.outputTokens ?? 0)))} tokens
                                  </span>
                                </>
                              )}
                              {sess.quota && (
                                <>
                                  <span>•</span>
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted/60 text-muted-foreground border border-border/40">
                                    {formatHeaderQuota(sess.quota)}
                                  </span>
                                </>
                              )}
                            </div>
                            <p className="text-xs font-semibold text-foreground truncate" title={sess.title}>
                              {sess.title}
                            </p>
                          </div>

                          {/* Sleek Balanced Action Toolbar */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              size="xs"
                              variant="default"
                              disabled={resumingTerminalId === sess.id || !mainSessionFor(sess, allSessions)}
                              onClick={() => { const main = mainSessionFor(sess, allSessions); if (main) void resumeTerminalSession(main.id, main.assistant, main.workspacePath); }}
                              title={sess.threadKind === 'subagent' ? 'Resume the main conversation instead of the delegated task' : `Resume session in terminal (${sess.id})`}
                            >
                              {resumingTerminalId === sess.id ? <Spinner className="size-3" /> : <Terminal size={12} />}
                              <span>{sess.threadKind === 'subagent' ? 'Main thread' : 'Resume'}</span>
                            </Button>

                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                setActiveSession(sess);
                                setTranscript([]);
                                fetchSessionTranscript(sess.assistant, sess.id);
                              }}
                              title="Inspect transcript log"
                            >
                              <MessageSquare size={12} />
                              <span>Logs</span>
                            </Button>

                            {sess.assistant === 'codex' && hasCodexDesktop && (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={openingDesktopId === sess.id}
                                onClick={() => void openCodexDesktop(sess.id)}
                                title="Open in Codex Desktop"
                              >
                                {openingDesktopId === sess.id ? <Spinner className="size-3" /> : <ExternalLink size={12} />}
                                <span>Desktop</span>
                              </Button>
                            )}

                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={async (e) => {
                                e.stopPropagation();
                                const cmd = getResumeCliCommand(sess.assistant, sess.id);
                                await safeCopyToClipboard(cmd);
                                setCopiedSessionId(sess.id);
                                setTimeout(() => setCopiedSessionId((id) => (id === sess.id ? null : id)), 1500);
                                showToast?.(`Copied: ${cmd}`, 'success');
                              }}
                              title={copiedSessionId === sess.id ? 'Copied CLI resume command' : 'Copy CLI resume command'}
                            >
                              {copiedSessionId === sess.id ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                            </Button>
                          </div>
                        </div>
                      ); })
                    )}
                  </div>
                )}
              </Card>
            );
          }))}
        </div>
      )}
    </div>
  );
};
