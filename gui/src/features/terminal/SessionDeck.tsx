import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Columns2, History, ListChecks, Plus, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { cn } from '../../lib/utils.js';
import { LiveDot } from '../chat/LiveMarker.js';
import { WORKING_WINDOW_MS } from '../chat/liveSessions.js';
import { RUNNING_TERMINALS_KEY, useRunningTerminals } from '../chat/useRunningTerminals.js';
import { terminalRequest, type TerminalInfo, type TerminalLaunch, type TerminalStatus } from './client.js';
import { adoptRunning, closeSlot, firstSlot, placeLaunch, slotLabels, type Slot } from './deckSlots.js';
import { TerminalPane, type PaneStatus } from './TerminalPane.js';

interface SessionDeckProps {
  workspace: string;
  active: boolean;
  launch?: TerminalLaunch;
  consumeLaunch: (id: string) => void;
  fillPromptRef: { current: ((text: string) => boolean) | null };
  onReply: (target: string) => void;
  onStatusChange?: (status: PaneStatus) => void;
  onBackgroundOutput?: () => void;
  onOpenFileReference?: (reference: { path: string; line?: number; cwd?: string }) => void;
  inspectorControls?: ReactNode;
  /** Where the work stands, in the toolbar after the tabs, shown with the tabs. */
  summary?: ReactNode;
}

interface Deck { slots: readonly Slot[]; active: string; split: string | null }

/**
 * The CLI sessions of one workspace, as tabs: Claude Code and Codex (or two of either) can work in the same workspace
 * at once, one click apart or side by side. Every tab keeps its terminal mounted and connected while hidden, so a
 * session never stops because another one is on screen. The strip above types into, and hears replies from, the tab
 * on screen.
 */
const CLOSE_PROBLEM_MS = 8000;

export function SessionDeck({ workspace, active, launch, consumeLaunch, fillPromptRef, onReply, onStatusChange, onBackgroundOutput, onOpenFileReference, inspectorControls, summary }: SessionDeckProps) {
  const queryClient = useQueryClient();
  const [deck, setDeck] = useState<Deck>(() => ({ slots: [firstSlot()], active: 'main', split: null }));
  const [infos, setInfos] = useState<Record<string, TerminalInfo | null>>({});
  const infosRef = useRef(infos);
  useEffect(() => { infosRef.current = infos; }, [infos]);
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({});
  // Tabs whose pane is starting or resuming a terminal. The server lists a new terminal before its start returns, so
  // nothing is adopted meanwhile, or it would get a second tab of its own.
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const deckRef = useRef(deck);
  useEffect(() => { deckRef.current = deck; }, [deck]);

  // The server's list of this workspace's terminals. Read once when the chat mounts, even off screen, so a terminal
  // that is already running gets its tab and stays connected; then every few seconds while the chat is on screen.
  const status = useQuery({
    queryKey: ['terminal-status', workspace],
    queryFn: () => terminalRequest<TerminalStatus>(workspace, 'status'),
    refetchInterval: active ? 5000 : false,
    staleTime: 2000,
    retry: 1,
  });
  // A list that cannot be read adopts nothing, so the first tab stops waiting and offers the tools.
  useEffect(() => {
    const sessions = status.data?.sessions ?? (status.isError ? [] : undefined);
    if (sessions && starting.size === 0) setDeck((current) => {
      const slots = adoptRunning(current.slots, sessions);
      return slots === current.slots ? current : { ...current, slots };
    });
  }, [status.data, status.isError, starting]);

  const show = useCallback((key: string) => setDeck((current) => (current.active === key ? current
    : { ...current, active: key, split: current.split === key ? current.active : current.split })), []);

  // A start or resume asked for from elsewhere in the app opens in the tab on screen if it is empty, else in a new one.
  const seenLaunch = useRef('');
  useEffect(() => {
    if (!launch || seenLaunch.current === launch.id) return;
    seenLaunch.current = launch.id;
    // Showing a running terminal opens nothing: its tab is brought on screen, if it has one yet.
    if (launch.terminalId) {
      const shown = deckRef.current.slots.find((slot) => slot.terminalId === launch.terminalId || infosRef.current[slot.key]?.id === launch.terminalId);
      if (shown) show(shown.key);
      consumeLaunch(launch.id);
      return;
    }
    // A conversation already running in a tab is shown, not opened twice.
    const running = launch.sessionId && status.data?.sessions.find((session) => session.state === 'running' && session.target === launch.target && session.sessionId === launch.sessionId);
    const holder = running && deckRef.current.slots.find((slot) => slot.terminalId === running.id || infosRef.current[slot.key]?.id === running.id);
    if (holder) {
      show(holder.key);
      consumeLaunch(launch.id);
      return;
    }
    setDeck((current) => ({ ...current, ...placeLaunch(current.slots, current.active, launch, `launch-${launch.id}`) }));
    // Read at the moment a launch arrives; a later list or tab change must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch]);

  const running = useRunningTerminals();
  const lastOutput = useMemo(() => new Map((running.data ?? []).map((terminal) => [terminal.id, terminal.lastOutputAt] as const)), [running.data]);
  const labels = slotLabels(deck.slots, (slot) => infos[slot.key]?.target ?? slot.launch?.target);
  const claimedBy = (key: string) => new Set(deck.slots.filter((slot) => slot.key !== key).map((slot) => infos[slot.key]?.id ?? slot.terminalId).filter((id): id is string => Boolean(id)));

  const add = (slot: Slot) => setDeck((current) => ({ ...current, slots: [...current.slots, slot], active: slot.key, split: current.split }));
  const startTool = (target: string) => {
    const id = crypto.randomUUID();
    add({ key: `slot-${id}`, terminalId: null, launch: { id, target } });
  };
  // Why the last close did not happen. A tab whose terminal still runs comes back with the next list, so it stays.
  const [closeProblem, setCloseProblem] = useState('');
  useEffect(() => {
    if (!closeProblem) return;
    const timer = setTimeout(() => setCloseProblem(''), CLOSE_PROBLEM_MS);
    return () => clearTimeout(timer);
  }, [closeProblem]);
  const close = async (key: string) => {
    const label = labels.get(key) ?? 'this session';
    if (starting.has(key)) { setCloseProblem(`${label} is still starting. Close it once it runs.`); return; }
    const terminal = infos[key];
    if (terminal && terminal.state === 'running') {
      if (!window.confirm(`End ${label}? Its running commands stop.`)) return;
      try { await terminalRequest(workspace, `${terminal.id}/stop`); }
      catch (error) {
        setCloseProblem(`${label} could not be ended, so it is still running: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: RUNNING_TERMINALS_KEY });
    }
    setCloseProblem('');
    setDeck((current) => closeSlot(current.slots, key, current.active, current.split));
    setInfos((current) => { const rest = { ...current }; delete rest[key]; return rest; });
    setStarting((current) => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; });
  };
  const toggleSplit = () => setDeck((current) => {
    if (current.split) return { ...current, split: null };
    const other = current.slots.find((slot) => slot.key !== current.active);
    if (other) return { ...current, split: other.key };
    const fresh = { key: `slot-${crypto.randomUUID()}`, terminalId: null };
    return { ...current, slots: [...current.slots, fresh], split: fresh.key };
  });

  // The strip types into the tab on screen.
  // One handle per tab, which its pane fills in once connected. Kept in state, not a ref, because render hands them out.
  const [fillRefs] = useState(() => new Map<string, { current: ((text: string) => boolean) | null }>());
  const fillRefOf = (key: string) => {
    let handle = fillRefs.get(key);
    if (!handle) { handle = { current: null }; fillRefs.set(key, handle); }
    return handle;
  };
  useEffect(() => {
    fillPromptRef.current = (text) => fillRefs.get(deckRef.current.active)?.current?.(text) ?? false;
    return () => { fillPromptRef.current = null; };
  }, [fillPromptRef, fillRefs]);

  // The chat's tab shows how the session on screen is doing.
  const statusChangeRef = useRef(onStatusChange);
  useEffect(() => { statusChangeRef.current = onStatusChange; }, [onStatusChange]);
  const shownStatus = statuses[deck.active];
  useEffect(() => { if (shownStatus) statusChangeRef.current?.(shownStatus); }, [shownStatus]);

  const targets = (status.data?.targets ?? []).filter((target) => target.available);
  const navigate = useNavigate();
  const tabs = (
    <div className="flex min-w-0 shrink items-center gap-0.5">
      {/* The plan is the workspace's first tab: the sessions open beside it. */}
      <button type="button" onClick={() => navigate(`/workspaces/${encodeURIComponent(workspace)}/plan`)} title="The plan: what needs you, the milestones, and what is next"
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
        <ListChecks aria-hidden="true" className="size-3.5" />Plan
      </button>
      {/* Only tabs in the tab list; Delete closes the focused one and the cross is the same for the mouse. */}
      <div role="tablist" aria-label="CLI sessions" className="flex min-w-0 items-center gap-0.5 overflow-x-auto no-scrollbar">
        {deck.slots.map((slot) => {
          const info = infos[slot.key];
          const target = info?.target ?? slot.launch?.target;
          const label = labels.get(slot.key) ?? 'New session';
          const selected = slot.key === deck.active || slot.key === deck.split;
          const output = info ? Date.parse(lastOutput.get(info.id) ?? '') : NaN;
          const working = Number.isFinite(output) && (running.dataUpdatedAt - output) <= WORKING_WINDOW_MS;
          const state = !info ? 'not started' : info.state === 'running' ? (working ? 'working' : 'idle') : 'ended';
          return (
            <button
              key={slot.key} type="button" role="tab" aria-selected={selected} aria-keyshortcuts="Delete" data-session={slot.key}
              aria-label={`${label}, ${state}`} title={`${label}: ${state}`}
              onClick={() => show(slot.key)}
              onKeyDown={(event) => { if (event.key === 'Delete') { event.preventDefault(); void close(slot.key); } }}
              className={cn('group inline-flex h-6 max-w-[11rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                selected ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
            >
              {target ? <HarnessIcon harness={target} className="size-3 shrink-0" /> : <Plus aria-hidden="true" className="size-3 shrink-0" />}
              <span className="truncate">{label}</span>
              {info?.state === 'running' && <LiveDot state={working ? 'working' : 'idle'} />}
              <span
                aria-hidden="true" data-close-session={slot.key} title={`Close ${label}`}
                onClick={(event) => { event.stopPropagation(); void close(slot.key); }}
                className={cn('size-3.5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:grid group-focus-visible:grid', selected && deck.slots.length > 1 ? 'grid' : 'hidden')}
              >
                <X className="size-2.5" />
              </span>
            </button>
          );
        })}
      </div>
      {closeProblem && <span role="alert" title={closeProblem} className="min-w-0 max-w-[16rem] truncate px-1 text-[11px] text-destructive">{closeProblem}</span>}
      <Menu>
        <MenuTrigger aria-label="Start another CLI" title="Start another CLI in this workspace" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground">
          <Plus className="size-3.5" aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-56 p-1">
          {targets.map((target) => (
            <MenuItem key={target.id} onClick={() => startTool(target.id)} className="flex items-center gap-2 text-xs">
              <HarnessIcon harness={target.id} className="size-3.5" />Start {harnessName(target.id)}
            </MenuItem>
          ))}
          {targets.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No CLI tools are installed.</p>}
          <div className="my-1 border-t border-border" />
          {/* A new tab opens on the tool buttons with the saved conversations under them. */}
          <MenuItem onClick={() => add({ key: `slot-${crypto.randomUUID()}`, terminalId: null })} className="flex items-center gap-2 text-xs">
            <History className="size-3.5" />Continue a saved conversation…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <IconButton
        label={deck.split ? 'Show one session' : 'Show two sessions side by side'} icon={<Columns2 />} aria-pressed={Boolean(deck.split)}
        onClick={toggleSplit} className={deck.split ? 'text-foreground' : 'text-muted-foreground'}
      />
    </div>
  );

  // Two sessions side by side stand in tab order, so the screen and the keyboard agree; the left one carries the tabs.
  // The one chosen last takes the keyboard, whichever side it is on.
  const shownKeys = deck.slots.filter((slot) => slot.key === deck.active || slot.key === deck.split).map((slot) => slot.key);
  const leftKey = shownKeys[0];
  return (
    <div className="flex h-full min-h-0">
      {deck.slots.map((slot) => {
        const shown = shownKeys.includes(slot.key);
        const left = slot.key === leftKey;
        return (
          <div key={slot.key} className={cn('min-h-0 min-w-0 flex-col', shown ? 'flex flex-1' : 'hidden', shown && !left && 'border-l border-border')}>
            <TerminalPane
              workspace={workspace} active={active && shown} primary={slot.key === deck.active}
              boundTerminalId={slot.adopt ? undefined : slot.terminalId} claimed={claimedBy(slot.key)}
              launch={slot.launch}
              consumeLaunch={(id) => {
                setDeck((current) => ({ ...current, slots: current.slots.map((other) => (other.key === slot.key && other.launch?.id === id ? { ...other, launch: undefined } : other)) }));
                if (id === launch?.id) consumeLaunch(id);
              }}
              onTerminalChange={(terminal) => {
                setInfos((current) => (current[slot.key] === terminal ? current : { ...current, [slot.key]: terminal }));
                if (terminal) setDeck((current) => ({ ...current, slots: current.slots.map((other) => (other.key === slot.key && other.terminalId !== terminal.id ? { ...other, terminalId: terminal.id } : other)) }));
                void queryClient.invalidateQueries({ queryKey: RUNNING_TERMINALS_KEY });
              }}
              onShowTerminal={(id) => {
                const holder = deckRef.current.slots.find((other) => other.terminalId === id || infos[other.key]?.id === id);
                if (holder) show(holder.key);
              }}
              onStatusChange={(next) => setStatuses((current) => (current[slot.key] === next ? current : { ...current, [slot.key]: next }))}
              onBusyChange={(busy) => setStarting((current) => {
                if (busy === current.has(slot.key)) return current;
                const next = new Set(current);
                if (busy) next.add(slot.key); else next.delete(slot.key);
                return next;
              })}
              onBackgroundOutput={onBackgroundOutput}
              onReply={onReply}
              fillPromptRef={fillRefOf(slot.key)}
              onOpenFileReference={onOpenFileReference}
              inspectorControls={left ? inspectorControls : undefined}
              summary={left ? summary : undefined}
              sessionTabs={left ? tabs : <span className="flex min-w-0 items-center gap-1.5 truncate px-1 text-xs font-medium text-foreground">{labels.get(slot.key)}</span>}
            />
          </div>
        );
      })}
    </div>
  );
}
