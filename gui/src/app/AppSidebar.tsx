import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Menu as MenuIcon,
  FolderGit2,
  Workflow,
  Boxes,
  Settings as SettingsIcon,
  BookOpen,
  Plus,
  Sun,
  Moon,
  Search,
  ChevronDown,
  ArrowUpDown,
  Check,
  Activity,
  Users,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { IconButton } from '../components/ui/icon-button.js';
import { ContextSpaceIcon } from '../components/icons/ContextSpaceIcon.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu.js';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils.js';
import { BRAND_NAME } from '../brand.js';
import { Sheet, SheetPopup, SheetTitle, SheetTrigger } from '../components/ui/sheet.js';
import { useIsMobile, useMediaQuery } from '../components/ui/use-mobile.js';
import { QuickSwitch } from './QuickSwitch.js';
import { useTheme, COLOR_THEMES } from './ThemeProvider.js';
import { useFloatingChat } from '../features/chat/floatingChatStore.js';
import { useChatThreads } from '../features/chat/useChatThreads.js';
import { shouldReadThreads } from '../features/chat/chatThreads.js';
import { activityNotes, useSessionActivity } from '../features/chat/sessionActivity.js';
import { ActivityDots } from '../features/chat/ActivityDots.js';
import { cycleKeysLabel, isApplePlatform, jumpKeyLabel, sessionModifierName } from '../features/workspace-shell/sessionShortcuts.js';
import { sessionInitials } from '../features/workspace-shell/sessionInitials.js';
import { focusSessionLink, sessionToFocusAfterClose } from '../features/workspace-shell/sessionFocus.js';
import { pathForSwitchingTo } from '../features/chat/chatRoute.js';
import { useChatAttention, useWindowAttentive } from '../features/chat/useChatAttention.js';
import { useLiveSessions } from '../features/chat/useLiveSessions.js';
import { liveText, runningFirst } from '../features/chat/liveSessions.js';
import { LiveDot, LiveMarker } from '../features/chat/LiveMarker.js';
import type { Feature, WorkspaceStatus } from '../types.js';
import { RepositoriesPanel, RepositoriesToggle } from './WorkspaceRepositories.js';
import { hasUnpreparedRepo } from '../features/worktrees/normalizeWorktrees.js';
import { normalizeWorktreeGroups } from '../features/worktrees/normalizeWorktrees.js';
import { hasBranchDrift } from '../features/worktrees/branchDrift.js';
import { PrepareRepoDialog } from '../features/worktrees/PrepareRepoDialog.js';
import { useWorkspaceRepositories } from '../lib/api/queries.js';
import { useWorktreeNavigationState } from '../features/worktrees/worktreeStore.js';

export type WorkspaceSortOption =
  | 'created-desc'
  | 'created-asc'
  | 'changes-desc'
  | 'name-asc'
  | 'repos-desc';

interface NavItem {
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
  match: (p: string) => boolean;
}

const SETUP_ITEMS: NavItem[] = [
  { label: 'Projects', description: 'Saved repository groups', to: '/projects', icon: FolderGit2, match: (p) => p.startsWith('/projects') },
  { label: 'Skills & agents', description: 'Assistant instructions', to: '/skills', icon: Boxes, match: (p) => p.startsWith('/skills') || p.startsWith('/agents') },
];

const ADVANCED_ITEMS: NavItem[] = [
  { label: 'Workrooms', description: 'Coordinate related work', to: '/workrooms', icon: Users, match: (p) => p.startsWith('/workrooms') },
  { label: 'Strategies', description: 'Reusable workflows', to: '/workflows', icon: Workflow, match: (p) => p.startsWith('/workflows') || p.startsWith('/strategies') },
];

export interface AppSidebarProps {
  appVersion: string;
  workspaces?: Feature[];
  workspaceStatuses?: Record<string, WorkspaceStatus>;
  workspacesLoading?: boolean;
  activeWsId?: string | null;
  /** Told when a workspace is chosen, so the sheet can close. The links go to their own addresses; this does not navigate. */
  onSelectWorkspace?: (id: string) => void;
  /** Checks for a new version on request; updates never install without confirmation. */
  onCheckForUpdates?: () => void;
  checkingForUpdates?: boolean;
}

function SidebarContents({
  appVersion,
  workspaces = [],
  workspaceStatuses = {},
  workspacesLoading = false,
  activeWsId = null,
  onSelectWorkspace,
  onCheckForUpdates,
  checkingForUpdates = false,
}: AppSidebarProps) {
  const { pathname } = useLocation();
  const { theme, setTheme, colorTheme, setColorTheme } = useTheme();
  const { openTabs, removeTab, openCli } = useFloatingChat();
  const apple = useMemo(() => isApplePlatform(), []);
  const modifierName = sessionModifierName(apple);

  const getSessionRoute = useCallback((branchName: string) => pathForSwitchingTo(branchName, pathname), [pathname]);
  // Closing a session from the list hands keyboard focus to its neighbour, so it is not dropped on the page.
  const closeSession = useCallback((branchName: string) => {
    const next = sessionToFocusAfterClose(openTabs, branchName);
    removeTab(branchName);
    if (next) requestAnimationFrame(() => focusSessionLink(next));
  }, [openTabs, removeTab]);
  const closeOnDelete = useCallback((event: React.KeyboardEvent, branchName: string) => {
    if (event.key !== 'Delete') return;
    event.preventDefault();
    closeSession(branchName);
  }, [closeSession]);
  // Where a CLI is running. Those workspaces come first, so one is never lost further down a long list.
  const { live: liveSessions, now: liveNow } = useLiveSessions();
  // What the browser's terminals report that the server cannot: stopped or disconnected, and output nobody has seen.
  const activity = useSessionActivity();
  // What each AI is waiting for: the first line of its question, until it is answered.
  const { open: openQuestions } = useChatAttention();
  const questions = useMemo(() => new Map(openQuestions.map((request) => [request.workspaceId, request.message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''] as const)), [openQuestions]);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<WorkspaceSortOption>('created-desc');
  const [visibleWorkspaceCount, setVisibleWorkspaceCount] = useState(30);
  // Archived workspaces are records, listed separately so they stay out of the way.
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(() => workspaces.filter((w) => w.archivedAt).length, [workspaces]);
  const [workspacesExpanded, setWorkspacesExpanded] = useState(true);
  const isWorkspacesListOpen = workspacesExpanded || search.trim().length > 0;
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);

  // Worktree & Rail State
  const { isCollapsed: savedCollapsed, toggleCollapsed: toggleSaved } = useWorktreeNavigationState();
  // In a narrow window (split screen, 200% zoom) the rail is the default so the
  // task keeps the room; expanding it there is temporary and leaves the saved choice alone.
  const narrow = useMediaQuery('(min-width: 768px) and (max-width: 999px)');
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const isCollapsed = narrow ? !narrowExpanded : savedCollapsed;
  const toggleCollapsed = useCallback(() => {
    if (narrow) setNarrowExpanded((expanded) => !expanded);
    else toggleSaved();
  }, [narrow, toggleSaved]);
  useEffect(() => { setNarrowExpanded(false); }, [pathname]);

  // The sidebar is the only place that shows what each open chat is working on, so it reads that: while it is the
  // full sidebar (the rail shows no summaries) and the window is being looked at. A closed mobile sheet is not mounted.
  const windowAttentive = useWindowAttentive();
  const chatThreads = useChatThreads(workspaces, shouldReadThreads({ sidebarExpanded: !isCollapsed, windowAttentive }));

  // Detect if on a workspace route
  const workspaceRouteMatch = pathname.match(/\/workspaces\/([^/]+)/);
  const currentWsId = workspaceRouteMatch ? decodeURIComponent(workspaceRouteMatch[1]!) : activeWsId;
  const isWorkspaceRoute = Boolean(currentWsId);

  const activeWorkspace = useMemo(() => {
    if (!currentWsId) return null;
    return workspaces.find((w) => w.branchName === currentWsId || w.id === currentWsId) || null;
  }, [workspaces, currentWsId]);

  const liveRepositories = useWorkspaceRepositories(activeWorkspace?.branchName ?? null);
  const [preparingRepo, setPreparingRepo] = useState<string | null>(null);
  // The active workspace's repositories are folded away until asked for. Nothing opens them by itself: when one needs
  // preparing for editing, the icon says so with a dot.
  const [repositoriesOpen, setRepositoriesOpen] = useState(false);
  const activeBranch = activeWorkspace?.branchName;
  useEffect(() => { setRepositoriesOpen(false); }, [activeBranch]);
  const repoGroups = useMemo(() => {
    if (!activeWorkspace) return [];
    return normalizeWorktreeGroups(activeWorkspace, workspaceStatuses[activeWorkspace.branchName], liveRepositories.data);
  }, [activeWorkspace, workspaceStatuses, liveRepositories.data]);
  const needsPreparing = !activeWorkspace?.archivedAt && hasUnpreparedRepo(repoGroups);
  const branchChanged = !activeWorkspace?.archivedAt && hasBranchDrift(repoGroups);

  // Keyboard shortcut for toggling rail (Z or [)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'z' || e.key === 'Z' || e.key === '[') {
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCollapsed]);

  const filteredWorkspaces = useMemo(() => {
    let list = workspaces.filter((w) => Boolean(w.archivedAt) === showArchived);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((w) => `${w.name ?? ''} ${w.branchName} ${w.description}`.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'created-desc': {
          const aTime = new Date(a.createdAt || 0).getTime();
          const bTime = new Date(b.createdAt || 0).getTime();
          return bTime - aTime;
        }
        case 'created-asc': {
          const aTime = new Date(a.createdAt || 0).getTime();
          const bTime = new Date(b.createdAt || 0).getTime();
          return aTime - bTime;
        }
        case 'changes-desc': {
          const aChg = workspaceStatuses[a.branchName]?.changedFiles || 0;
          const bChg = workspaceStatuses[b.branchName]?.changedFiles || 0;
          return bChg - aChg;
        }
        case 'repos-desc': {
          return (b.repos?.length || 0) - (a.repos?.length || 0);
        }
        case 'name-asc': {
          return (a.name || a.branchName).localeCompare(b.name || b.branchName);
        }
        default:
          return 0;
      }
    });
  }, [workspaces, search, sortBy, workspaceStatuses, showArchived]);

  const otherWorkspaces = useMemo(() => {
    return filteredWorkspaces.filter((w) => !openTabs.includes(w.branchName) && !openTabs.includes(w.id));
  }, [filteredWorkspaces, openTabs]);

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer',
      active ? 'bg-primary/10 text-primary font-semibold' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
    );

  const sortLabelMap: Record<WorkspaceSortOption, string> = {
    'created-desc': 'Newest',
    'created-asc': 'Oldest',
    'changes-desc': 'Changes',
    'name-asc': 'A–Z',
    'repos-desc': 'Repos',
  };

  // ─── COLLAPSED RAIL MODE (56px / w-14) ─────────────────────────────────────
  if (isCollapsed) {
    return (
      <aside className="context-sidebar flex w-14 shrink-0 flex-col border-r border-border bg-card select-none h-screen overflow-hidden transition-[width] duration-200 items-center py-3 justify-between z-30">
        {/* Top Icons */}
        <div className="flex flex-col items-center gap-3 w-full">
          <Link to="/overview" aria-label={`${BRAND_NAME} overview`} title={`${BRAND_NAME} v${appVersion}`}>
            <ContextSpaceIcon size={24} className="rounded-md shadow-xs hover:scale-105 transition-transform" />
          </Link>

          <NavLink
            to="/overview"
            aria-label="Overview Activity"
            title="Overview Activity"
            className={({ isActive }) =>
              cn(
                'p-2 rounded-lg transition-colors cursor-pointer',
                isActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )
            }
          >
            <Activity size={16} />
          </NavLink>

          <NavLink
            to="/new"
            aria-label="Start new work"
            title="Start new work"
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Plus size={16} />
          </NavLink>

          {/* Open Sessions Stack */}
          {openTabs.length > 0 && (
            <>
              <div className="my-1 w-6 border-t border-border/60" />
              <div className="flex flex-col items-center gap-1.5 overflow-y-auto no-scrollbar max-h-[calc(100vh-230px)] w-full px-2" role="group" aria-label="Open sessions">
                {openTabs.map((tab, idx) => {
                  const ws = workspaces.find((w) => w.branchName === tab || w.id === tab);
                  const isSelected = currentWsId === tab || activeWsId === tab;
                  const live = liveSessions.get(tab);
                  const question = questions.get(tab);
                  const st = workspaceStatuses[tab];
                  const hasChanges = Boolean(st && st.changedFiles > 0);
                  const label = ws?.name || tab;
                  const shortcutNum = idx < 9 ? idx + 1 : null;
                  const notes = activityNotes(activity[tab]).map((note) => `, ${note.toLowerCase()}`).join('');

                  return (
                    <div key={`rail-${tab}`} className="group relative flex items-center justify-center w-full">
                      {isSelected && (
                        <span
                          className="absolute -left-2 top-1.5 bottom-1.5 w-1 rounded-r-full bg-primary z-20"
                          aria-hidden="true"
                        />
                      )}
                      <Link
                        to={getSessionRoute(tab)}
                        onClick={() => onSelectWorkspace?.(tab)}
                        onKeyDown={(event) => closeOnDelete(event, tab)}
                        data-sidebar-session={tab}
                        aria-keyshortcuts="Delete"
                        aria-current={isSelected ? 'page' : undefined}
                        aria-label={`Open session: ${label}${isSelected ? ' (active)' : ''}${shortcutNum ? ` (${modifierName}+${shortcutNum})` : ''}${notes}`}
                        title={`Session ${idx + 1}: ${label}${isSelected ? ' (Active Session)' : ''}${shortcutNum ? ` · ${modifierName}+${shortcutNum}` : ''}${question !== undefined ? ` · Waiting${question ? `: ${question}` : ''}` : live ? ` · ${liveText(live, liveNow)}` : hasChanges ? ` · ±${st!.changedFiles} changes` : ''}${notes.replace(/, /g, ' · ')}`}
                        className={cn(
                          'relative flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold tracking-tight transition-colors cursor-pointer',
                          isSelected
                            ? 'bg-primary text-primary-foreground shadow-sm z-10'
                            : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent'
                        )}
                      >
                        <span aria-hidden="true">{sessionInitials(label)}</span>
                        <ActivityDots activity={activity[tab]} announce={false} className="absolute bottom-1 right-1" />
                        {question !== undefined ? (
                          <span className="absolute top-1 right-1 size-2 rounded-full bg-amber-500 animate-pulse" title="Waiting for your input" />
                        ) : live ? (
                          <span className="absolute top-1 right-1">
                            <LiveDot state={live.state} title={liveText(live, liveNow)} />
                          </span>
                        ) : hasChanges ? (
                          <span className={cn('absolute top-1 right-1 size-1.5 rounded-full', isSelected ? 'bg-amber-300' : 'bg-amber-400')} title={`${st!.changedFiles} changed files`} />
                        ) : null}
                      </Link>
                      <button
                        type="button"
                        onClick={() => closeSession(tab)}
                        aria-label={`Close session ${label}`}
                        title={`Close session ${label}`}
                        className="absolute left-0 -top-0.5 z-20 grid size-4 place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-hover:opacity-100 group-focus-within:opacity-100 cursor-pointer"
                      >
                        <X size={10} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* The workspace on screen when it is not one of the open sessions (archived, or its chat was closed). It sits
              after them, so showing it never moves a session. */}
          {isWorkspaceRoute && activeWorkspace && !openTabs.includes(activeWorkspace.branchName) && (
            <>
              <div className="my-1 w-6 border-t border-border/60" />
              <div className="relative flex items-center justify-center w-full">
                <span
                  className="absolute -left-2 top-1.5 bottom-1.5 w-1 rounded-r-full bg-primary z-20"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label={`Active Workspace: ${activeWorkspace.branchName} (Click to expand)`}
                  title={`Active Workspace: ${activeWorkspace.branchName} (Click to expand)`}
                  className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-semibold tracking-tight text-primary-foreground shadow-sm transition-colors cursor-pointer"
                >
                  <span aria-hidden="true">{sessionInitials(activeWorkspace.name || activeWorkspace.branchName)}</span>
                  {(workspaceStatuses[activeWorkspace.branchName]?.changedFiles ?? 0) > 0 && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-300 animate-pulse" />
                  )}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Bottom Expand Control */}
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand Cockpit Sidebar (Shortcut: z)"
            title="Expand Cockpit Sidebar (Shortcut: z)"
            className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 border border-border/50 transition-colors cursor-pointer"
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      </aside>
    );
  }

  // ─── EXPANDED COCKPIT MODE (240px / w-60) ──────────────────────────────────
  return (
    <aside className="context-sidebar flex w-64 shrink-0 flex-col border-r border-border bg-card select-none h-screen overflow-hidden transition-[width] duration-200">
      {/* Top Header */}
      <div className="flex h-11 items-center justify-between px-3 border-b border-border/60">
        <Link to="/overview" className="flex items-center gap-2 group">
          <ContextSpaceIcon size={22} className="rounded-md shadow-xs transition-transform duration-200 group-hover:scale-105" />
          <span className="text-xs font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">
            {BRAND_NAME}
          </span>
        </Link>
        <span className="flex items-center gap-0.5">
          <span className="text-[10px] font-mono text-muted-foreground">v{appVersion}</span>
          {onCheckForUpdates && (
            <IconButton label="Check for updates" icon={<RefreshCw className={checkingForUpdates ? 'animate-spin' : undefined} />} disabled={checkingForUpdates} onClick={onCheckForUpdates} className="text-muted-foreground" />
          )}
        </span>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 flex flex-col gap-2">
        {(
          /* ─── WORKSPACE LIST ─────────────────────────────────────────────
             Always shown, on a workspace page too, so moving between workspaces never
             means going back first. The active one is marked, and its repositories and
             branches are one disclosure away instead of replacing the list. */
          <div className="flex flex-col gap-2 min-w-0">
            {/* QuickSwitch */}
            <QuickSwitch workspaces={workspaces} />

            {/* Top Nav Actions */}
            <div className="flex flex-col gap-0.5">
              <NavLink to="/overview" aria-label="Overview" className={({ isActive }) => linkClass(isActive)}>
                <Activity size={14} />
                <span className="min-w-0"><span className="block">Overview</span><span className="block text-[10px] font-normal text-muted-foreground">Pick up where you left off</span></span>
              </NavLink>
              <NavLink to="/new" aria-label="New workspace" className={({ isActive }) => linkClass(isActive)}>
                <Plus size={14} />
                <span className="min-w-0"><span className="block">New workspace</span><span className="block text-[10px] font-normal text-muted-foreground">Start a task with your repos</span></span>
              </NavLink>
            </div>

            {/* Open Sessions Section */}
            {openTabs.length > 0 && (
              <div className="pt-2 border-t border-border/60">
                <div className="flex items-center justify-between pb-1 px-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Open Sessions
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground [@media(hover:none)]:hidden">
                      ({cycleKeysLabel(apple)})
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.2 rounded-full">
                    {openTabs.length}
                  </span>
                </div>
                <div className="flex flex-col gap-1" role="group" aria-label="Open sessions list">
                  {openTabs.map((tab, idx) => {
                    const ws = workspaces.find((w) => w.branchName === tab || w.id === tab);
                    const isSelected = currentWsId === tab || activeWsId === tab;
                    const live = liveSessions.get(tab);
                    const question = questions.get(tab);
                    const thread = chatThreads.summaries.get(tab);
                    const needsYou = question !== undefined ? 'Waiting for you' : thread?.tone === 'needs' ? thread.label : '';
                    const line = question || thread?.goal || '';
                    const st = workspaceStatuses[tab];
                    const hasChanges = Boolean(st && st.changedFiles > 0);
                    const label = ws?.name || tab;
                    const shortcutNum = idx < 9 ? idx + 1 : null;
                    const showRepositories = isSelected && repositoriesOpen && Boolean(activeWorkspace);

                    return (
                      <div key={`open-session-${tab}`}>
                        <div
                          className={cn(
                            'group relative flex items-start gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors border',
                            isSelected
                              ? 'bg-primary/10 text-foreground border-primary/30 font-semibold shadow-2xs pl-3'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground border-transparent'
                          )}
                        >
                          {isSelected && (
                            <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-primary" aria-hidden="true" />
                          )}
                          <Link
                            to={getSessionRoute(tab)}
                            onClick={() => onSelectWorkspace?.(tab)}
                            onKeyDown={(event) => closeOnDelete(event, tab)}
                            data-sidebar-session={tab}
                            aria-keyshortcuts="Delete"
                            aria-current={isSelected ? 'page' : undefined}
                            className="flex min-w-0 flex-1 flex-col gap-0.5"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isSelected ? (
                                <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                              ) : (
                                <FolderGit2 size={13} className="shrink-0 text-muted-foreground" />
                              )}
                              <span className={cn('truncate font-medium', isSelected ? 'text-foreground' : 'text-foreground/90')} title={label}>
                                {label}
                              </span>
                              <ActivityDots activity={activity[tab]} />
                              {shortcutNum && (
                                <span className="ml-auto text-[9px] font-mono font-normal text-muted-foreground bg-muted/60 px-1 py-0.2 rounded [@media(hover:none)]:hidden" title={`Shortcut: ${modifierName}+${shortcutNum}`}>
                                  {jumpKeyLabel(shortcutNum, apple)}
                                </span>
                              )}
                              {live && (
                                <span className={cn('shrink-0', shortcutNum ? 'ml-1' : 'ml-auto')}>
                                  <LiveDot state={live.state} title={liveText(live, liveNow)} />
                                </span>
                              )}
                            </div>
                            <span className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                              {question ? (
                                <span className="truncate font-medium text-[var(--state-needs)]" title={question}>
                                  <span className="sr-only">Waiting for you: </span>{question}
                                </span>
                              ) : line || needsYou ? (
                                <>
                                  {needsYou && <span className="state-chip shrink-0" data-tone="needs">{needsYou}</span>}
                                  {line && <span className="truncate" title={line}>{line}</span>}
                                </>
                              ) : (
                                <>
                                  {ws?.name && <span className="truncate font-mono" title={tab}>{tab}</span>}
                                  <span className="shrink-0 whitespace-nowrap">{ws?.repos.length ?? 0} {ws?.repos.length === 1 ? 'repo' : 'repos'}</span>
                                </>
                              )}
                              {hasChanges && <span className="shrink-0 whitespace-nowrap text-warning-foreground font-semibold">• ±{st!.changedFiles}</span>}
                            </span>
                          </Link>
                          <div className="flex items-center gap-1 shrink-0">
                            {isSelected && activeWorkspace && (
                              <RepositoriesToggle branch={tab} open={repositoriesOpen} needsPreparing={needsPreparing} branchChanged={branchChanged} onToggle={() => setRepositoriesOpen((open) => !open)} />
                            )}
                            {!ws?.archivedAt && (
                              <button
                                type="button"
                                onClick={() => openCli(tab)}
                                className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary cursor-pointer"
                                title={`Resume CLI chat for ${tab}`}
                                aria-label={`Resume CLI chat for ${tab}`}
                              >
                                <History size={12} aria-hidden="true" />
                              </button>
                            )}
                            {live && <LiveMarker live={live} now={liveNow} />}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                closeSession(tab);
                              }}
                              aria-label={`Close session ${label}`}
                              title={`Close session ${label}`}
                              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 p-1 rounded hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-primary hover:text-destructive text-muted-foreground transition-opacity cursor-pointer shrink-0"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                        {showRepositories && activeWorkspace && (
                          <RepositoriesPanel groups={repoGroups} archived={Boolean(activeWorkspace.archivedAt)} onPrepare={setPreparingRepo} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workspaces Section */}
            <div className="pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={() => setWorkspacesExpanded((open) => !open)}
                aria-expanded={isWorkspacesListOpen}
                className="flex w-full items-center justify-between pb-1.5 px-1 text-left rounded hover:bg-accent/40 transition-colors group cursor-pointer"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <ChevronDown
                    size={12}
                    className={cn('shrink-0 text-muted-foreground transition-transform duration-200', !isWorkspacesListOpen && '-rotate-90')}
                  />
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider group-hover:text-foreground transition-colors">
                    {showArchived ? 'Archived workspaces' : 'Workspaces'}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.2 rounded-full shrink-0">
                  {otherWorkspaces.length}
                </span>
              </button>

              {isWorkspacesListOpen && (
                <>
                  {/* Filter Search & Sort */}
                  <div className="flex items-center gap-1 mb-2 mt-1">
                    <div className="relative flex-1">
                      <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none z-10" />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); setVisibleWorkspaceCount(30); }}
                        placeholder="Filter..."
                        className="w-full rounded-md border border-border/60 bg-muted/30 pl-6 pr-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:bg-background focus:outline-hidden focus:ring-1 focus:ring-primary"
                      />
                    </div>

                    <Menu>
                      <MenuTrigger
                        aria-label="Sort workspaces"
                        className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                      >
                        <ArrowUpDown size={11} />
                      </MenuTrigger>
                      <MenuPopup side="bottom" align="end" className="w-36 text-xs">
                        {(Object.keys(sortLabelMap) as WorkspaceSortOption[]).map((key) => (
                          <MenuItem key={key} onClick={() => { setSortBy(key); setVisibleWorkspaceCount(30); }} className="flex items-center justify-between">
                            <span>{sortLabelMap[key]}</span>
                            {sortBy === key && <Check size={12} className="text-primary" />}
                          </MenuItem>
                        ))}
                      </MenuPopup>
                    </Menu>
                  </div>

                  {/* Workspaces Rows */}
                  <div className="flex flex-col gap-1">
                    {workspacesLoading && workspaces.length === 0 ? (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground italic">
                        Loading workspaces...
                      </div>
                    ) : otherWorkspaces.length === 0 ? (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground italic">
                        {search.trim() ? 'No workspaces match' : showArchived ? 'No archived workspaces' : 'No active workspaces'}
                      </div>
                    ) : (
                      runningFirst(otherWorkspaces, liveSessions).slice(0, visibleWorkspaceCount).map((w, index, shown) => {
                        const isSelected = currentWsId === w.branchName || currentWsId === w.id || activeWsId === w.branchName || activeWsId === w.id;
                        const live = liveSessions.get(w.branchName);
                        const startsRunning = Boolean(live) && index === 0;
                        const endsRunning = !live && index > 0 && liveSessions.has(shown[index - 1]!.branchName);
                        const st = workspaceStatuses[w.branchName];
                        const hasChanges = Boolean(st && st.changedFiles > 0);
                        // A workspace with an open chat or a running CLI says what the AI asks while it waits, else what the
                        // chat is working on, and when it needs you.
                        const thread = chatThreads.summaries.get(w.branchName);
                        const question = questions.get(w.branchName);
                        const needsYou = question !== undefined ? 'Waiting for you' : thread?.tone === 'needs' ? thread.label : '';
                        const line = question || thread?.goal || '';
                        const showRepositories = isSelected && repositoriesOpen && Boolean(activeWorkspace);

                        return (
                          <div key={w.id}>
                          {startsRunning && <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Running now</p>}
                          {endsRunning && <div aria-hidden="true" className="mx-2.5 mb-2 mt-1 border-t border-border/70" />}
                          <div
                            className={cn(
                              'group flex items-start gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors border',
                              isSelected
                                ? 'bg-accent text-foreground font-medium border-border/70 shadow-2xs'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground border-transparent'
                            )}
                          >
                            <Link
                              to={`/workspaces/${encodeURIComponent(w.branchName)}`}
                              onClick={() => onSelectWorkspace?.(w.branchName)}
                              aria-current={isSelected ? 'page' : undefined}
                              className="flex min-w-0 flex-1 flex-col gap-0.5"
                            >
                              <span className="truncate font-medium text-foreground" title={w.name || w.branchName}>
                                {w.name || w.branchName}
                              </span>
                              <span className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                                {question ? (
                                  // The dot beside the row already says it waits, so the room goes to what it asks.
                                  <span className="truncate font-medium text-[var(--state-needs)]" title={question}><span className="sr-only">Waiting for you: </span>{question}</span>
                                ) : line || needsYou ? (
                                  <>
                                    {needsYou && <span className="state-chip shrink-0" data-tone="needs">{needsYou}</span>}
                                    {line && <span className="truncate" title={line}>{line}</span>}
                                  </>
                                ) : (
                                  <>
                                    {w.name && <span className="truncate font-mono" title={w.branchName}>{w.branchName}</span>}
                                    {!w.name && w.description && <span className="truncate" title={w.description}>{w.description}</span>}
                                    <span className="shrink-0 whitespace-nowrap">{w.repos.length} {w.repos.length === 1 ? 'repo' : 'repos'}</span>
                                  </>
                                )}
                                {w.archivedAt && <span className="font-semibold">archived</span>}
                                {hasChanges && <span className="shrink-0 whitespace-nowrap text-warning-foreground font-semibold">• ±{st!.changedFiles}</span>}
                              </span>
                              {live && <span className="sr-only">{liveText(live, liveNow)}</span>}
                            </Link>
                            <div className="flex items-center gap-1 shrink-0">
                              {isSelected && activeWorkspace && (
                                <RepositoriesToggle branch={w.branchName} open={repositoriesOpen} needsPreparing={needsPreparing} branchChanged={branchChanged} onToggle={() => setRepositoriesOpen((open) => !open)} />
                              )}
                              {!w.archivedAt && (
                                <button
                                  type="button"
                                  onClick={() => openCli(w.branchName)}
                                  className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                                  title={`Resume CLI chat for ${w.branchName}`}
                                  aria-label={`Resume CLI chat for ${w.branchName}`}
                                >
                                  <History size={12} aria-hidden="true" />
                                </button>
                              )}
                              {/* Only where a CLI runs. Uncommitted changes are the ± count beside the name. */}
                              {live && <LiveMarker live={live} now={liveNow} />}
                            </div>
                          </div>
                          {showRepositories && activeWorkspace && (
                            <RepositoriesPanel groups={repoGroups} archived={Boolean(activeWorkspace.archivedAt)} onPrepare={setPreparingRepo} />
                          )}
                          </div>
                        );
                      })
                    )}
                  </div>
                  {otherWorkspaces.length > visibleWorkspaceCount && (
                    <button type="button" className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => setVisibleWorkspaceCount((count) => count + 30)}>
                      Show more workspaces ({otherWorkspaces.length - visibleWorkspaceCount} remaining)
                    </button>
                  )}
                  {(archivedCount > 0 || showArchived) && (
                    <button
                      type="button"
                      aria-pressed={showArchived}
                      className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => { setShowArchived((shown) => !shown); setVisibleWorkspaceCount(30); }}
                    >
                      {showArchived ? 'Back to active workspaces' : `Show archived (${archivedCount})`}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {activeWorkspace && <PrepareRepoDialog wsId={activeWorkspace.branchName} repoName={preparingRepo} onClose={() => setPreparingRepo(null)} />}

        <div className="border-t border-border/60 pt-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Reusable setup</p>
          {SETUP_ITEMS.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.to} to={item.to} aria-label={item.label} className={linkClass(item.match(pathname))}>
              <Icon size={14} />
              <span className="min-w-0"><span className="block">{item.label}</span><span className="block text-[10px] font-normal text-muted-foreground">{item.description}</span></span>
            </NavLink>;
          })}
          <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Advanced tools</p>
          {ADVANCED_ITEMS.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.to} to={item.to} aria-label={item.label} className={linkClass(item.match(pathname))}>
              <Icon size={14} />
              <span className="min-w-0"><span className="block">{item.label}</span><span className="block text-[10px] font-normal text-muted-foreground">{item.description}</span></span>
            </NavLink>;
          })}
        </div>

        <div className="mt-auto border-t border-border/60 pt-2">
          <NavLink to="/settings" aria-label="Settings" className={linkClass(pathname.startsWith('/settings'))}>
            <SettingsIcon size={14} /><span>Settings</span>
          </NavLink>
          <a href="https://github.com/antan87/NexusFlow#readme" target="_blank" rel="noreferrer"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <BookOpen size={14} /><span>Guide</span>
          </a>
          <button type="button" onClick={() => setAppearanceExpanded((open) => !open)} aria-expanded={appearanceExpanded}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <span>Appearance</span><ChevronDown size={13} className={cn('transition-transform', appearanceExpanded && 'rotate-180')} />
          </button>
          {appearanceExpanded && <div className="space-y-2 p-2">
            <div className="grid grid-cols-5 gap-1">
              {COLOR_THEMES.map((palette) => <button key={palette.id} type="button" onClick={() => setColorTheme(palette.id)}
                aria-label={`Switch to ${palette.label} palette`} aria-pressed={colorTheme === palette.id}
                title={`${palette.label} palette — ${palette.description}`}
                className={cn('flex flex-col items-center gap-1 rounded p-1 text-[10px]', colorTheme === palette.id ? 'bg-accent ring-1 ring-border' : 'hover:bg-accent/60')}>
                <span className={cn('size-2 rounded-full', palette.dotClass)} />{palette.label}
              </button>)}
            </div>
            <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>}
        </div>
      </div>

      {/* Bottom Footer: Rail Collapse Control */}
      <div className="h-9 px-3 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground bg-muted/20">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-1.5 hover:text-foreground transition-colors cursor-pointer text-[11px]"
          title="Collapse rail into icon strip (Shortcut: z)"
        >
          <PanelLeftClose size={13} />
          <span>Collapse (z)</span>
        </button>
      </div>
    </aside>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (!isMobile) return <SidebarContents {...props} />;

  return (
    <div className="fixed inset-x-0 top-0 z-40 flex h-12 items-center border-b border-border bg-card px-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger className="inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium" aria-label="Open navigation">
          <MenuIcon size={20} /> {BRAND_NAME}
        </SheetTrigger>
        <SheetPopup
          side="left"
          className="w-72"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContents
            {...props}
            onSelectWorkspace={(id) => {
              props.onSelectWorkspace?.(id);
              setOpen(false);
            }}
          />
        </SheetPopup>
      </Sheet>
    </div>
  );
}
