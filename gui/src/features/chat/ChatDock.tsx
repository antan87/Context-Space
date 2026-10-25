import { TerminalWorkspace } from '../terminal/TerminalWorkspace.js';
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  X,
  Plus,
  Search,
  FolderGit2,
  MessageSquare,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import type { Feature } from '../../types.js';
import { useFloatingChat, CHAT_GEOMETRY } from './floatingChatStore.js';
import { attentionStore } from './chatAttention.js';
import { sessionActivity } from './sessionActivity.js';
import { focusSessionLink } from '../workspace-shell/sessionFocus.js';
import { useChatAttention, useWindowAttentive } from './useChatAttention.js';
import { useChatDockSlot, useDockRect } from './dockPlacement.js';
import { browserPath, goToWorkspace, parseWorkspacePath, showsChatFor } from './chatRoute.js';
import { RUNNING_TERMINALS_KEY } from './useLiveSessions.js';
import { computeMountedWorkspaces } from './chatMountedWorkspaces.js';

interface ChatDockProps {
  workspaces: Feature[];
}

/**
 * The CLI chat, docked as the centre of the workspace screen. It lives above the
 * router, so every open workspace's terminal keeps running, keeps its scrollback
 * and keeps its unsent text while the user reads a plan or reviews changes. It is
 * only shown over the slot the Chat destination provides; everywhere else it is
 * hidden, not unmounted.
 */
export function ChatDock({ workspaces }: ChatDockProps) {
  const navigate = useNavigate();
  const {
    openTabs,
    activeTab,
    splitTab,
    splitRatio,
    focusRequest,
    openCli,
    removeTab,
    setSplitTab,
    setSplitRatio,
    terminalLaunches, consumeTerminalLaunch,
  } = useFloatingChat();

  const slot = useChatDockSlot();
  const rect = useDockRect(slot);
  const onScreen = rect !== null;
  // The effects below run on events, and need to know whether the chat is on screen as of that moment.
  const onScreenRef = useRef(onScreen);
  useEffect(() => { onScreenRef.current = onScreen; }, [onScreen]);

  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerVisibleCount, setPickerVisibleCount] = useState(12);
  const dockRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef(false);
  // A second workspace beside the first needs room for two terminals.
  const wideEnough = (rect?.width ?? 0) >= CHAT_GEOMETRY.splitBreakpointPx;
  const showSplit = Boolean(splitTab && activeTab && splitTab !== activeTab && wideEnough);

  // Bounded pool of mounted workspaces: keep active and most recently active terminals mounted
  // in the DOM so switching is instant without reattaching, while older inactive workspaces
  // unmount synchronously to prevent unbounded element growth and transient multi-pane spikes.
  const recentWorkspacesRef = useRef<string[]>([]);
  const mountedWorkspaces = useMemo(() => {
    const next = computeMountedWorkspaces(openTabs, activeTab, splitTab, showSplit, recentWorkspacesRef.current);
    recentWorkspacesRef.current = next;
    return next;
  }, [openTabs, activeTab, splitTab, showSplit]);

  // Anything in the app can ask to see a chat (a waiting alert, "resume in chat", a session link).
  // The dock answers by going to that workspace's chat. The first value is the one at load, so a reload stays put.
  const seenFocus = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === seenFocus.current) return;
    seenFocus.current = focusRequest;
    if (!activeTab) return;
    // Compared with the browser's address, which is already where the user is going, not the page's older copy.
    // The part open beside the chat stays open for the workspace that takes its place, so choosing another workspace
    // while reading the plan shows its plan beside its chat.
    const here = browserPath();
    if (showsChatFor(here, activeTab, onScreenRef.current)) return;
    goToWorkspace(navigate, activeTab, onScreenRef.current ? parseWorkspacePath(here)?.section ?? 'chat' : 'chat');
  }, [focusRequest, activeTab, navigate]);

  // A request counts as seen once its chat is on screen in a window the user is
  // looking at. A chat left open on another monitor must keep its alert.
  const { pending } = useChatAttention();
  const attentive = useWindowAttentive();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!onScreen || !attentive) return;
    const shown = new Set([activeTab, showSplit ? splitTab : null].filter((value): value is string => Boolean(value)));
    for (const request of pending) {
      if (shown.has(request.workspaceId)) attentionStore.markSeen(request.workspaceId, request.id);
    }
  }, [pending, onScreen, attentive, activeTab, splitTab, showSplit]);

  // What a terminal printed while its chat was away is unread until the chat is on screen again.
  useEffect(() => {
    if (onScreen) sessionActivity.markSeen([activeTab, showSplit ? splitTab : null]);
  }, [onScreen, activeTab, splitTab, showSplit]);
  // A chat that is closed leaves nothing behind, so reopening it starts clean.
  useEffect(() => { sessionActivity.prune(openTabs); }, [openTabs]);

  const moveSplit = useCallback((event: React.PointerEvent) => {
    if (!splitDragRef.current || !bodyRef.current) return;
    const bounds = bodyRef.current.getBoundingClientRect();
    setSplitRatio(((event.clientX - bounds.left) / bounds.width) * 100);
  }, [setSplitRatio]);

  // Map open branch names to workspace objects
  const workspaceMap = useMemo(() => {
    return new Map(workspaces.map((w) => [w.branchName, w]));
  }, [workspaces]);

  // The empty state's own search, kept separate from the header menu's query so
  // the two surfaces never clear or filter each other.
  const pickerQueryTrimmed = pickerQuery.trim();
  const pickerMatches = useMemo(() => {
    const q = pickerQueryTrimmed.toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (w) => w.branchName.toLowerCase().includes(q) || (w.description && w.description.toLowerCase().includes(q)),
    );
  }, [workspaces, pickerQueryTrimmed]);

  // Progressive reveal rather than a hard cap: a long list stays scannable, but
  // nothing becomes unreachable the way a fixed slice made it.
  const pickerVisible = pickerMatches.slice(0, pickerVisibleCount);

  // Announced through a status region that exists before the first keystroke;
  // the visible "No workspaces match" line alone is never read out.
  const pickerAnnouncement = !pickerQueryTrimmed ? ''
    : pickerMatches.length === 0 ? `No workspaces match "${pickerQueryTrimmed}"`
    : `${pickerMatches.length} ${pickerMatches.length === 1 ? 'workspace matches' : 'workspaces match'}`;

  // The picker unmounts what was just activated: choosing a workspace removes the
  // whole empty state, and the last "Show N more" click removes its own button.
  // Move focus to what replaced it so keyboard and screen-reader users are not
  // dropped back on <body>.
  const pickerListRef = useRef<HTMLDivElement>(null);
  // Choosing a workspace here replaces this whole screen, which would drop keyboard focus on <body>. The session it
  // opens, in the sidebar, receives it instead.
  const focusOpenedSession = useRef<string | null>(null);
  useEffect(() => {
    const branch = focusOpenedSession.current;
    if (!branch || !openTabs.includes(branch)) return;
    focusOpenedSession.current = null;
    focusSessionLink(branch);
  }, [openTabs]);
  const focusRevealedIndex = useRef<number | null>(null);
  useEffect(() => {
    const index = focusRevealedIndex.current;
    if (index === null) return;
    focusRevealedIndex.current = null;
    pickerListRef.current?.querySelectorAll<HTMLElement>('button')[index]?.focus();
  }, [pickerVisibleCount]);

  return (
    <div
      ref={dockRef}
      style={rect ? { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` } : { display: 'none' }}
      role="region" aria-label="CLI Chat"
      className="fixed z-10 flex flex-col overflow-hidden bg-card"
    >
      {splitTab && !wideEnough && onScreen && <p className="border-b border-border px-3 py-1 text-xs text-muted-foreground">Showing two workspaces is paused. Make this area wider to resume it.</p>}
      {/* Main Chat Body (Multi-Tab Mounted Execution) */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 overflow-hidden bg-card">
        {openTabs.length === 0 ? (
          <div className="flex h-full w-full flex-col items-center gap-3 overflow-y-auto p-6 text-center text-muted-foreground">
            <div className="grid size-12 shrink-0 place-items-center rounded-2xl border border-border bg-muted/50 text-muted-foreground">
              <MessageSquare className="size-6 text-primary" />
            </div>
            <div className="shrink-0 space-y-1">
              <h3 className="text-sm font-semibold text-foreground">Choose a workspace for CLI chat</h3>
              <p className="max-w-xs text-xs text-muted-foreground">
                Open an existing workspace or create one. A session starts only when you choose to start or resume it.
              </p>
            </div>
            {/* This state used to render workspaces.slice(0, 5) with no way to
                reach the rest. Search plus progressive reveal keeps every
                workspace reachable without dumping a long list at once. */}
            {workspaces.length > 0 && (
              <div className="relative w-full max-w-sm shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search workspaces for CLI chat"
                  placeholder="Search workspaces..."
                  value={pickerQuery}
                  onChange={(event) => { setPickerQuery(event.target.value); setPickerVisibleCount(12); }}
                  className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                />
                <p role="status" data-testid="cli-chat-picker-results" className="sr-only">{pickerAnnouncement}</p>
              </div>
            )}
            <div className="flex w-full max-w-sm flex-col gap-1.5">
              {workspaces.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">No workspaces yet.</p>
              ) : pickerMatches.length === 0 ? (
                // The status region above already says this; hidden so it is not read twice.
                <p aria-hidden="true" className="py-2 text-xs text-muted-foreground">No workspaces match "{pickerQueryTrimmed}"</p>
              ) : (
                <>
                  <div ref={pickerListRef} className="flex flex-col gap-1.5" role="group" aria-label="Workspaces available for CLI chat">
                    {pickerVisible.map((ws) => (
                      <Button
                        key={ws.branchName}
                        variant="outline"
                        size="sm"
                        onClick={() => { focusOpenedSession.current = ws.branchName; openCli(ws.branchName); setPickerQuery(''); }}
                        className="h-7 justify-start gap-1.5 text-xs"
                      >
                        <FolderGit2 className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{ws.branchName}</span>
                        {ws.description && <span className="truncate text-[10px] font-normal text-muted-foreground">{ws.description}</span>}
                      </Button>
                    ))}
                  </div>
                  {pickerMatches.length > pickerVisible.length && (
                    <Button variant="ghost" size="sm" onClick={() => { focusRevealedIndex.current = pickerVisible.length; setPickerVisibleCount(count => count + 24); }}
                      className="h-7 text-xs">
                      Show {Math.min(24, pickerMatches.length - pickerVisible.length)} more of {pickerMatches.length}
                    </Button>
                  )}
                </>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate('/new?from=chat')} className="h-7 gap-1.5 text-xs"><Plus className="size-3" />Create workspace for CLI chat</Button>
            </div>
          </div>
        ) : (
          // The terminals stay in one fixed order, whatever order the tabs are in, so bringing a tab to the front never
          // moves a running terminal in the page.
          [...openTabs].sort().map((branchName) => {
            const ws = workspaceMap.get(branchName);
            const isPrimary = branchName === activeTab;
            const isSecondary = showSplit && branchName === splitTab;
            const shown = isPrimary || isSecondary;
            const isMounted = shown || mountedWorkspaces.includes(branchName);

            if (!isMounted) return null;

            return (
              <div
                key={branchName}
                className={cn('h-full min-h-0 min-w-0 flex-col', shown ? 'flex' : 'hidden', isSecondary && 'border-l border-border')}
                style={shown ? { order: isPrimary ? 1 : 3, flex: showSplit ? isPrimary ? `0 0 ${splitRatio}%` : '1 1 0%' : '1 1 100%' } : undefined}
              >
                {isSecondary && <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-2 py-1">
                  <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={branchName}>{branchName}</span>
                  <Button size="xs" variant="ghost" aria-label="Undock this workspace" onClick={() => setSplitTab(null)}><X className="size-3" /></Button>
                </div>}
                {!ws ? <div role="status" className="space-y-2 p-4 text-xs text-muted-foreground"><p>This workspace is unavailable. It may have been removed or is still loading.</p><Button size="xs" variant="outline" onClick={() => removeTab(branchName)}>Close unavailable tab</Button></div> : <>
                  <div className="min-h-0 flex-1">
                    <TerminalWorkspace workspace={branchName} workspacePath={ws.workspacePath} repoPaths={ws.repos} active={onScreen && shown} launch={terminalLaunches[branchName]} consumeLaunch={id => consumeTerminalLaunch(branchName, id)}
                      onStatusChange={(status) => {
                        sessionActivity.setStatus(branchName, status);
                        // A CLI that starts or stops shows in the sidebar at once, not at the next read.
                        void queryClient.invalidateQueries({ queryKey: RUNNING_TERMINALS_KEY });
                      }}
                      onBackgroundOutput={() => sessionActivity.markUnread(branchName)} />
                  </div>
                </>}
              </div>
            );
          })
        )}
        {showSplit && <div role="separator" aria-label="Resize workspace panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(splitRatio)} tabIndex={0}
          className="relative order-2 z-10 w-1.5 shrink-0 cursor-col-resize touch-none bg-border/70 transition-colors hover:bg-primary/50 focus-visible:outline-none focus-visible:bg-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 before:absolute before:inset-y-0 before:-left-1.5 before:w-[18px] before:content-['']"
          onPointerDown={event => { splitDragRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={moveSplit}
          onPointerUp={event => { splitDragRef.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { splitDragRef.current = false; }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSplitRatio(splitRatio + (event.key === 'ArrowRight' ? 5 : -5)); } }} />}
      </div>
    </div>
  );
}
