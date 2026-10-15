import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal, type IBufferLine } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from '../../components/ui/menu.js';
import { HarnessIcon, harnessName } from '../../components/icons/HarnessIcon.js';
import { History, RefreshCw, ExternalLink, Square, Search, Copy, PlugZap, WifiOff, MoreHorizontal } from 'lucide-react';
import { floatingChatStore, useFloatingChat } from '../chat/floatingChatStore.js';
import { browserPath } from '../chat/chatRoute.js';
import { resolveWorkspaceShortcut } from '../workspace-shell/sessionShortcuts.js';
import { ResumeSessions } from './ResumeSessions.js';
import { findTerminalUsageSession, SessionUsageDetails } from './SessionUsage.js';
import { apiFetch } from '../../lib/api/client.js';
import { clipboardHtmlToText, readClipboardText, safeCopyToClipboard } from '../../lib/clipboard.js';
import { terminalRequest, terminalToken, terminalSocketUrl, type TerminalInfo, type TerminalLaunch, type TerminalStatus } from './client.js';
import { findFileReferences, type FileReference } from './fileReferences.js';
import { findWebLinks } from './webLinks.js';
import { toPromptText } from './promptFill.js';
import { SHIFT_ENTER_SEQUENCE, terminalKeyAction } from './terminalKeys.js';
import type { AISession } from '../../types.js';

/**
 * Transport state of the pane, as a closed union.
 *
 * This used to be a free-form string inspected with `startsWith('Connected')`
 * and friends at four call sites, so rewording a message silently broke the
 * status label, the tab dot and the `aria-label` together.
 */
type PaneState =
  | { kind: 'connecting' }
  | { kind: 'running' }
  | { kind: 'exited'; code: number | null; early?: boolean }
  | { kind: 'disconnected'; detail?: string }
  /** The backend no longer has this terminal: it expired or the backend restarted. */
  | { kind: 'ended' };

/** A harness that exits with an error this soon after starting could not begin its work. */
const EARLY_EXIT_MS = 15_000;

const PANE_STATE_LABEL: Record<PaneState['kind'], string> = {
  connecting: 'Connecting…',
  running: 'Running',
  exited: 'Exited',
  disconnected: 'Disconnected',
  ended: 'Ended',
};

const PANE_STATE_HELP: Record<PaneState['kind'], string> = {
  connecting: 'Input is paused while the terminal connects.',
  running: 'Input is ready. Hiding this window keeps the CLI running.',
  exited: 'The terminal has stopped. Its output stays available.',
  disconnected: 'Input is paused. The CLI keeps running for up to 5 minutes without a connected window; reconnect to continue.',
  ended: 'This terminal is no longer running. Terminals end when ContextSpace restarts or after 5 minutes with no window connected.',
};

/** Reported to the modal, which paints the per-tab status dot. */
export type PaneStatus = 'idle' | 'running' | 'exited' | 'disconnected';

const paneStatusFor = (kind: PaneState['kind']): PaneStatus => {
  switch (kind) {
    case 'running': return 'running';
    case 'disconnected': return 'disconnected';
    case 'exited': case 'ended': return 'exited';
    case 'connecting': return 'idle';
  }
};

interface Props { workspace: string; active: boolean; launch?: TerminalLaunch; consumeLaunch: (id: string) => void; onOpenFileReference?: (reference: Pick<FileReference, 'path' | 'line'> & { cwd?: string }) => void; inspectorControls?: ReactNode;
  /** Where the work stands, in the toolbar's free room after the tabs. */
  summary?: ReactNode; onStatusChange?: (status: PaneStatus) => void; onBackgroundOutput?: () => void; fillPromptRef?: { current: ((text: string) => boolean) | null };
  /** The developer sent a line to an assistant (not a plain shell): their reply to whatever it asked. */
  onReply?: (target: string) => void;
  /** The terminal this pane shows, chosen by its session tab: null for none yet, undefined while the tab still looks.
   * The pane never picks a running one by itself. */
  boundTerminalId?: string | null;
  /** Terminals other tabs show. Resuming one of them shows that tab instead of opening the session twice. */
  claimed?: ReadonlySet<string>;
  /** Tells the session tabs which terminal this pane shows now. */
  onTerminalChange?: (terminal: TerminalInfo | null) => void;
  /** Asks the session tabs to show the tab that holds this terminal. */
  onShowTerminal?: (id: string) => void;
  /** The session tabs, at the start of the toolbar. */
  sessionTabs?: ReactNode;
  /** Takes the keyboard when shown. False for the second session shown beside the first. */
  primary?: boolean;
  /** True while this pane starts or resumes a terminal, so the tabs do not give it a tab of its own meanwhile. */
  onBusyChange?: (busy: boolean) => void }
export function TerminalPane({ workspace, active, launch, consumeLaunch, onOpenFileReference, inspectorControls, summary, onStatusChange, onBackgroundOutput, fillPromptRef, onReply, boundTerminalId, claimed, onTerminalChange, onShowTerminal, sessionTabs, primary = true, onBusyChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const { harnesses, setHarness } = useFloatingChat();
  const target = harnesses[workspace] ?? '';
  const setTarget = useCallback((value: string) => setHarness(workspace, value), [workspace, setHarness]);
  // The saved conversations shown over an ended terminal. A pane with no terminal lists them under the tool buttons.
  const [showHistory, setShowHistory] = useState(false);
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  useEffect(() => { if (terminal) setShowHistory(false); }, [terminal]);
  const [paneState, setPaneState] = useState<PaneState>({ kind: 'connecting' });
  const [endedByUser, setEndedByUser] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [screenReader, setScreenReader] = useState(false);
  const [clipboardMenu, setClipboardMenu] = useState<{ x: number; y: number } | null>(null);
  const menuSelection = useRef('');
  const launchSeen = useRef('');
  const lastLaunch = useRef<TerminalLaunch | undefined>(undefined);
  const [retryLaunch, setRetryLaunch] = useState<TerminalLaunch | undefined>(undefined);
  const usageHistory = useQuery({
    queryKey: ['terminal-resume-sessions', workspace],
    queryFn: ({ signal }) => apiFetch<{ sessions: AISession[] }>(`/api/workspace/${encodeURIComponent(workspace)}/sessions`, { signal }),
    enabled: active && !!terminal && terminal.target !== 'shell',
    staleTime: 15_000,
    refetchInterval: active && terminal && paneState.kind === 'running' ? 30_000 : false,
  });
  const usageSession = terminal && usageHistory.data
    ? findTerminalUsageSession(terminal, usageHistory.data.sessions, status?.sessions)
    : undefined;
  // Derived from the backend's list, so a refresh after an expiry or restart
  // reports the terminal as ended rather than as a connection problem.
  const gone = !!terminal && !!status && !status.sessions.some(s => s.id === terminal.id);
  const shownState: PaneState = gone ? { kind: 'ended' } : paneState;
  const shownKind = shownState.kind;
  const activeRef = useRef(active);
  const primaryRef = useRef(primary);
  useEffect(() => { primaryRef.current = primary; }, [primary]);
  const boundRef = useRef(boundTerminalId);
  const terminalChangeRef = useRef(onTerminalChange);
  useEffect(() => { terminalChangeRef.current = onTerminalChange; }, [onTerminalChange]);
  const openFileRef = useRef(onOpenFileReference);
  const statusChangeRef = useRef(onStatusChange);
  const backgroundOutputRef = useRef(onBackgroundOutput);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { openFileRef.current = onOpenFileReference; }, [onOpenFileReference]);
  // Where the session runs, so a relative path it prints resolves from there. Read by the link providers.
  const cwdRef = useRef<string | undefined>(undefined);
  useEffect(() => { cwdRef.current = terminal?.cwd; }, [terminal]);
  useEffect(() => { statusChangeRef.current = onStatusChange; backgroundOutputRef.current = onBackgroundOutput; }, [onStatusChange, onBackgroundOutput]);
  const replyRef = useRef(onReply);
  useEffect(() => { replyRef.current = onReply; }, [onReply]);
  // Read by the key handler, which is set up once per terminal.
  const targetRef = useRef<string | undefined>(undefined);
  useEffect(() => { targetRef.current = terminal?.target; }, [terminal]);
  useEffect(() => {
    statusChangeRef.current?.(paneStatusFor(shownKind));
  }, [shownKind]);
  const send = useCallback((message: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)); }, []);
  // Lets the Where Are We strip type a suggestion into the prompt. It only types: the text has every
  // line break and control character removed, so the developer is the one who presses Enter. Nothing is
  // typed while the terminal is disconnected, replaying or ended, and the caller is told so.
  useEffect(() => {
    if (!fillPromptRef) return;
    fillPromptRef.current = (text: string) => {
      const data = toPromptText(text);
      const term = renderer.current;
      if (!data || !term || term.options.disableStdin || socket.current?.readyState !== WebSocket.OPEN) return false;
      send({ type: 'input', data });
      if (activeRef.current) term.focus();
      return true;
    };
    return () => { fillPromptRef.current = null; };
  }, [fillPromptRef, send]);
  // Only the latest status request may replace the list; an older response that
  // lacks a just-created terminal would otherwise report it as ended.
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const next = await terminalRequest<TerminalStatus>(workspace, 'status');
      if (seq !== refreshSeq.current) return;
      setStatus(next);
      // Prefer the backend's view of the session we already track, so a session that exited while the pane was
      // closed is not shown as still running. A pane with none shows the one its tab holds; the tabs, not the pane,
      // decide which running terminal goes where, so two panes never show the same one.
      setTerminal(current => next.sessions.find(s => s.id === current?.id) ?? current ?? (boundRef.current ? next.sessions.find(s => s.id === boundRef.current) ?? null : null));
      if (!next.available) setError(next.reason || 'Native terminal support is unavailable.');
    } catch (e) { setError((e as Error).message); }
  }, [workspace]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The tab hands this pane a terminal after it has mounted (one already running when the workspace opened).
  useEffect(() => {
    boundRef.current = boundTerminalId;
    if (!boundTerminalId || terminal?.id === boundTerminalId) return;
    const found = status?.sessions.find(s => s.id === boundTerminalId);
    if (found) setTerminal(found); else void refresh();
    // Only a new binding matters; the pane's own terminal and list change for other reasons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundTerminalId]);
  useEffect(() => { terminalChangeRef.current?.(terminal); }, [terminal]);
  const busyChangeRef = useRef(onBusyChange);
  useEffect(() => { busyChangeRef.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { busyChangeRef.current?.(busy); }, [busy]);
  useEffect(() => {
    // Older saved window state has no harness choice. Recover the actual tool.
    if (terminal && !target) setTarget(terminal.target);
  }, [terminal, target, setTarget]);
  useEffect(() => {
    // Renew the browser owner cookie for long-running, even hidden sessions.
    const timer = window.setInterval(() => { void terminalToken().catch(() => {}); }, 4 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true, fontFamily: '"JetBrains Mono", monospace', fontSize: 13, scrollback: 5000, allowProposedApi: false,
      theme: { background: '#111b18', foreground: '#e1e9e4', cursor: '#a3dbae' },
      // Hyperlinks a CLI embeds in its output (OSC 8). Without a handler xterm asks for confirmation and
      // opens a file:// link in a blank window, which shows nothing; files open in Code like printed paths.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
          else if (/^file:\/\//i.test(uri)) openFileRef.current?.({ path: uri, cwd: cwdRef.current });
        },
      },
    });
    const sizing = new FitAddon(), searching = new SearchAddon();
    term.loadAddon(sizing); term.loadAddon(searching); term.open(host.current);
    const terminalHost = host.current;
    const onPasteShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
        // Keep Ctrl+V out of the PTY: Codex interprets a literal Ctrl+V as
        // its image-paste command on Windows. The browser still dispatches its
        // ordinary paste event to xterm's focused textarea.
        event.stopPropagation();
      }
    };
    terminalHost.addEventListener('keydown', onPasteShortcut, true);
    const onPaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard || clipboard.getData('text/plain')) return;
      const richText = clipboardHtmlToText(clipboard.getData('text/html'));
      if (richText.trim()) {
        event.preventDefault(); event.stopPropagation();
        if (!term.options.disableStdin) term.paste(richText);
      } else if ([...clipboard.items].some(item => item.type.startsWith('image/')) || [...clipboard.files].some(file => file.type.startsWith('image/'))) {
        event.preventDefault(); event.stopPropagation();
        // Claude Code and Codex paste an image by reading the clipboard themselves when they get Ctrl+V. The CLI runs on
        // this machine, so it sees the same clipboard; the key is only sent for an image, never with text, so it cannot
        // paste twice. A plain shell has nothing to do with an image.
        if (targetRef.current && targetRef.current !== 'shell') {
          if (!term.options.disableStdin) send({ type: 'input', data: '\x16' });
        } else setError('The clipboard contains an image but no text. Copy text and paste again.');
      }
    };
    terminalHost.addEventListener('paste', onPaste, true);
    // The same question the window asks, so a key the app will not use reaches the CLI.
    const isSessionKey = (event: Parameters<typeof terminalKeyAction>[0]) => resolveWorkspaceShortcut({
      event, openTabs: floatingChatStore.getState().openTabs, activeTab: floatingChatStore.getState().activeTab, pathname: browserPath(),
    }) !== null;
    term.attachCustomKeyEventHandler(event => {
      switch (terminalKeyAction(event, term.hasSelection(), isSessionKey)) {
        case 'copy':
          event.preventDefault();
          void safeCopyToClipboard(term.getSelection()).then(copied => {
            if (!copied) setError('Select terminal output before copying, or check clipboard permissions.');
            else setError('');
          });
          return false;
        // Let the browser dispatch its native paste event into xterm's textarea.
        // xterm handles that event, including bracketed paste for CLI harnesses.
        case 'paste':
          return false;
        case 'newline':
          event.preventDefault();
          term.input(SHIFT_ENTER_SEQUENCE);
          return false;
        case 'suppress':
          return false;
        default:
          return true;
      }
    });
    const getWindowedRows = (bufferLineNumber: number) => {
      const buffer = term.buffer.active;
      let first = bufferLineNumber - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped && bufferLineNumber - first <= 20) first--;
      if (buffer.getLine(first)?.isWrapped) return null;
      let last = bufferLineNumber - 1;
      while (buffer.getLine(last + 1)?.isWrapped && last - first < 20) last++;
      if (buffer.getLine(last + 1)?.isWrapped) return null;
      const rows: { line: IBufferLine; text: string }[] = [];
      for (let at = first; at <= last; at++) {
        const line = buffer.getLine(at);
        if (!line) return null;
        rows.push({ line, text: line.translateToString(at === last) });
      }
      const positionAt = (offset: number, ending: boolean) => {
        let before = 0;
        for (let row = 0; row < rows.length; row++) {
          const length = rows[row].text.length;
          if (offset < before + length || (ending && offset === before + length) || row === rows.length - 1) {
            const local = Math.max(0, offset - before);
            let column = 0;
            while (column < term.cols && rows[row].line.translateToString(false, 0, column).length < local) column++;
            return { x: column + (ending ? 0 : 1), y: first + row + 1 };
          }
          before += length;
        }
        return { x: 1, y: first + 1 };
      };
      return { rows, text: rows.map(r => r.text).join(''), positionAt };
    };
    const webLinks = term.registerLinkProvider({ provideLinks(bufferLineNumber, callback) {
      const windowed = getWindowedRows(bufferLineNumber);
      if (!windowed) { callback([]); return; }
      callback(findWebLinks(windowed.text).map(link => ({
        text: link.text,
        range: { start: windowed.positionAt(link.start, false), end: windowed.positionAt(link.end, true) },
        activate: () => {
          window.open(link.url, '_blank', 'noopener,noreferrer');
        },
      })));
    } });
    const links = term.registerLinkProvider({ provideLinks(bufferLineNumber, callback) {
      const windowed = getWindowedRows(bufferLineNumber);
      if (!windowed) { callback([]); return; }
      callback(findFileReferences(windowed.text).map(reference => ({
        text: reference.text,
        range: { start: windowed.positionAt(reference.start, false), end: windowed.positionAt(reference.end, true) },
        activate: () => openFileRef.current?.({ path: reference.path, line: reference.line, cwd: cwdRef.current }),
      })));
    } });
    renderer.current = term; fit.current = sizing; search.current = searching;
    const input = term.onData(data => {
      // Never queue keystrokes while disconnected, replaying, or after exit.
      if (term.options.disableStdin) return;
      for (let at = 0; at < data.length;) {
        let end = Math.min(at + 8192, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        send({ type: 'input', data: data.slice(at, end) }); at = end;
      }
      // Enter, typed on its own, sends the line: to an assistant, it is the developer's reply to what it asked. A paste
      // that holds a line break is not.
      if (data === '\r' && targetRef.current && targetRef.current !== 'shell') replyRef.current?.(targetRef.current);
    });
    term.options.disableStdin = true;
    const resize = term.onResize(({ cols, rows }) => {
      if (!term.options.disableStdin && cols >= 2 && rows >= 1) send({ type: 'resize', cols: Math.min(Math.max(cols, 2), 500), rows: Math.min(Math.max(rows, 1), 300) });
    });
    const observer = new ResizeObserver(() => {
      if (host.current?.clientWidth && host.current?.clientHeight) {
        sizing.fit();
        if (activeRef.current) term.scrollToBottom();
      }
    });
    observer.observe(host.current);
    return () => { terminalHost.removeEventListener('keydown', onPasteShortcut, true); terminalHost.removeEventListener('paste', onPaste, true); observer.disconnect(); webLinks.dispose(); links.dispose(); input.dispose(); resize.dispose(); term.dispose(); renderer.current = null; };
  }, [send]);
  useEffect(() => {
    if (!active || !terminal) return;
    let frameId: number;
    let attempts = 0;
    const maxAttempts = 10;
    // The mode switch first reveals a previously hidden terminal. Wait for that
    // layout before fitting and focusing xterm's real input textarea.
    const tryActivate = () => {
      if (!activeRef.current) return;
      if (!host.current?.getClientRects().length || !host.current?.clientWidth || !host.current?.clientHeight) {
        attempts++;
        if (attempts < maxAttempts) {
          frameId = requestAnimationFrame(tryActivate);
        }
        return;
      }
      fit.current?.fit();
      const term = renderer.current;
      if (term) {
        term.scrollToBottom();
        if (term.rows > 0) {
          term.refresh(0, term.rows - 1);
        }
        if (!term.options.disableStdin && term.cols >= 2 && term.rows >= 1) {
          send({ type: 'resize', cols: Math.min(Math.max(term.cols, 2), 500), rows: Math.min(Math.max(term.rows, 1), 300) });
        }
        if (primaryRef.current) term.focus();
      }
    };
    frameId = requestAnimationFrame(tryActivate);
    return () => cancelAnimationFrame(frameId);
    // Keyed on the session id: a status refresh replaces the session object and
    // must not pull focus back from another panel into the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, terminal?.id]);
  useEffect(() => { if (renderer.current) renderer.current.options.screenReaderMode = screenReader; }, [screenReader]);

  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    let ws: WebSocket | undefined;
    let ended = terminal.state === 'exited';
    let missing = false;
    let replayed = false;
    const term = renderer.current;
    if (!term) return;
    term.reset(); term.options.disableStdin = true; setPaneState({ kind: 'connecting' });
    void terminalToken().then(token => {
      if (cancelled) return;
      ws = new WebSocket(terminalSocketUrl()); socket.current = ws;
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'attach', token, workspace, id: terminal.id }));
      ws.onmessage = event => {
        if (cancelled) return;
        const message = JSON.parse(String(event.data));
        if (message.type === 'ready') {
          ended = message.terminal.state === 'exited';
          setError(message.truncated ? 'Earlier output was trimmed. This is a partial screen replay; use the harness redraw command if needed.' : '');
          setPaneState({ kind: 'connecting' });
        } else if (message.type === 'output' && typeof message.data === 'string') {
          if (replayed && !activeRef.current) backgroundOutputRef.current?.();
          term.write(message.data, () => { if (!cancelled && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', count: message.data.length })); });
        } else if (message.type === 'replayed') {
          replayed = true;
          term.write('', () => {
            if (cancelled) return;
            term.options.disableStdin = ended;
            // An exit that arrived while the replay flushed keeps its code.
            setPaneState(current => ended ? (current.kind === 'exited' ? current : { kind: 'exited', code: null }) : { kind: 'running' });
            if (!ended) {
              fit.current?.fit();
              if (term.cols >= 2 && term.rows >= 1) {
                send({ type: 'resize', cols: Math.min(Math.max(term.cols, 2), 500), rows: Math.min(Math.max(term.rows, 1), 300) });
              }
              term.scrollToBottom();
              if (term.rows > 0) term.refresh(0, term.rows - 1);
              if (activeRef.current && primaryRef.current) term.focus();
            }
          });
        } else if (message.type === 'exit') {
          const code = message.exitCode ?? null;
          // Measured with the backend's exit time, so a replayed exit is judged the same way.
          const early = terminal.target !== 'shell' && code !== null && code !== 0 && Date.parse(message.exitedAt ?? '') - Date.parse(terminal.startedAt ?? '') < EARLY_EXIT_MS;
          ended = true; term.options.disableStdin = true; setPaneState({ kind: 'exited', code, early });
          setTerminal(current => current?.id === terminal.id ? { ...current, state: 'exited', exitCode: message.exitCode } : current);
          setStatus(current => current && ({ ...current, sessions: current.sessions.map(s => s.id === terminal.id ? { ...s, state: 'exited' } : s) }));
        } else if (message.type === 'error') {
          term.options.disableStdin = true;
          // An ended terminal cannot be reconnected; say so instead of offering Reconnect forever.
          if (message.code === 'terminal_not_found') { missing = true; setError(''); void refresh(); }
          else setError(message.message);
        }
      };
      ws.onclose = () => { if (!cancelled) { term.options.disableStdin = true; setPaneState(missing ? { kind: 'ended' } : ended ? { kind: 'exited', code: null } : { kind: 'disconnected' }); } };
      ws.onerror = () => { if (!cancelled) setError('Connection failed. Reconnect to the existing terminal; it may still be running.'); };
    }).catch(e => { if (!cancelled) { setError((e as Error).message); setPaneState({ kind: 'disconnected' }); } });
    return () => { cancelled = true; term.options.disableStdin = true; ws?.close(); if (socket.current === ws) socket.current = null; };
    // Visibility changes only resize; they must never open another connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal?.id, retry, workspace, send]);

  const start = useCallback(async (request: TerminalLaunch) => {
    lastLaunch.current = request; setRetryLaunch(request); setBusy(true); setError(''); setTarget(request.target);
    try {
      const { terminal: created } = await terminalRequest<{ terminal: TerminalInfo }>(workspace, 'create', { launchId: request.id, target: request.target, sessionId: request.sessionId, cwd: request.cwd, ...(request.prompt ? { prompt: request.prompt } : {}) });
      setStatus(current => current && ({ ...current, sessions: [...current.sessions.filter(s => s.id !== created.id), created] }));
      setTerminal(created);
      setShowHistory(false);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [workspace, refresh, setTarget]);
  // A launch for a session that is already running must attach to it. Creating a
  // second terminal would leave two shells on one session and lose the first.
  const resume = useCallback(async (request: TerminalLaunch): Promise<void> => {
    // Only the backend's list is authoritative: the pane's own copy of an ended
    // terminal still reads as running and must not swallow the resume. A pane
    // opened just for this resume has not read the list yet, so it reads it first.
    let sessions = status?.sessions;
    if (request.sessionId && !sessions) {
      try { sessions = (await terminalRequest<TerminalStatus>(workspace, 'status')).sessions; } catch { sessions = []; }
    }
    const existing = request.sessionId && (sessions ?? []).find(item =>
      item.state === 'running' && item.target === request.target && item.sessionId === request.sessionId);
    if (existing && claimed?.has(existing.id)) {
      onShowTerminal?.(existing.id);
      return;
    }
    if (existing) {
      setTerminal(existing);
      setTarget(existing.target);
      setShowHistory(false);
      return;
    }
    return start(request);
  }, [status, start, setTarget, claimed, onShowTerminal, workspace]);
  useEffect(() => {
    if (!launch || launchSeen.current === launch.id) return;
    launchSeen.current = launch.id;
    void resume(launch).finally(() => consumeLaunch(launch.id));
  }, [launch, resume, consumeLaunch]);

  const stop = async () => {
    if (!terminal || !window.confirm('End this terminal and its running commands?')) return;
    try { await terminalRequest(workspace, `${terminal.id}/stop`); setEndedByUser(true); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };
  const copySelection = async (captured?: string) => {
    try {
      const selected = captured || renderer.current?.getSelection() || '';
      if (!selected) {
        setError('Select terminal output before copying.');
        return;
      }
      if (!await safeCopyToClipboard(selected)) setError('Could not copy terminal output. Check browser clipboard permissions.');
      else setError('');
    } finally {
      // The context-menu button is removed after click. Focus on the next
      // frame so its unmount cannot steal focus back from xterm's textarea.
      requestAnimationFrame(() => renderer.current?.focus());
    }
  };
  const pasteClipboard = async () => {
    setClipboardMenu(null);
    try {
      const value = await readClipboardText();
      if (!value) throw new Error('Clipboard has no text');
      if (!renderer.current || renderer.current.options.disableStdin) throw new Error('Reconnect the terminal before pasting.');
      renderer.current.paste(value);
      renderer.current.focus();
      setError('');
    } catch {
      setError('No clipboard text was available. Focus the terminal and press Ctrl+V (or Cmd+V); attach image-only content in Chat.');
    }
  };
  const external = async () => {
    setError('');
    try {
      const request = lastLaunch.current;
      await apiFetch(`/api/workspace/${encodeURIComponent(workspace)}/terminal`, { method: 'POST', body: JSON.stringify({ ...(target !== 'shell' ? { assistant: target } : {}), ...(request?.target === target ? { sessionId: request.sessionId, cwd: request.cwd } : {}) }) });
    } catch (e) { setError((e as Error).message); }
  };
  // Every installed tool is one click away, the one used last here first. A tool that is not installed is left out.
  const tools = useMemo(() => {
    const available = (status?.targets ?? []).filter(item => item.available);
    return [...available.filter(item => item.id === target), ...available.filter(item => item.id !== target)];
  }, [status?.targets, target]);
  const missing = status?.targets.find(item => item.id === target && !item.available);
  // A list that could not be read is reported once, in the alert under the toolbar, not as a check that never ends.
  const problem = !status
    ? (error ? '' : 'Checking which CLI tools are installed…')
    : !status.available
      ? status.reason || 'The local terminal service is unavailable. Refresh after it is ready.'
      : tools.length === 0
        ? 'No CLI tools were found. Install one (Claude Code, Codex…), then refresh.'
        : missing
          ? `${harnessName(missing.id)}, used last here, is not available: ${missing.reason || 'not installed'}.`
          : '';
  const disconnected = shownState.kind === 'disconnected';
  const exited = shownState.kind === 'exited' || shownState.kind === 'ended';
  const running = shownState.kind === 'running';
  const stateLabel = shownState.kind === 'exited' && endedByUser ? 'Ended' : shownState.kind === 'exited' && shownState.code != null ? `Exited (${shownState.code})` : PANE_STATE_LABEL[shownState.kind];
  const stateHelp = shownState.kind === 'exited' && shownState.early
    ? `${harnessName(terminal?.target ?? target)} stopped right after starting. Check its output above: if it asks you to sign in or finish setup, do that in an External terminal, then start again.`
    : PANE_STATE_HELP[shownState.kind];
  // Only the backend's link says which conversation an ended terminal ran; the
  // usage heuristic can pick a sibling's conversation once the list is empty.
  const resumableId = terminal && terminal.target !== 'shell' ? terminal.sessionId : undefined;
  const resumeButton = gone && terminal && (resumableId
    ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void resume({ id: crypto.randomUUID(), target: terminal.target, sessionId: resumableId })}><History className="size-3" />Resume conversation</Button>
    : terminal.target !== 'shell' && <Button size="xs" variant="ghost" onClick={() => setShowHistory(true)}><History className="size-3" />Continue a conversation</Button>);
  const stateDotClass = running ? 'bg-emerald-500' : exited ? 'bg-muted-foreground' : disconnected ? 'bg-warning' : 'bg-amber-500';
  const usageSummary = useMemo(() => {
    if (usageHistory.isPending) return 'Checking session usage…';
    if (usageHistory.isError) return 'Usage could not be loaded. Refresh to try again.';
    if (!usageSession) return 'No matching saved usage is available for this CLI session. Refresh after a turn.';
    return null;
  }, [usageHistory.isPending, usageHistory.isError, usageSession]);
  const [paneMenuOpen, setPaneMenuOpen] = useState(false);
  return <div className="flex h-full min-h-0 flex-col" data-testid="terminal-pane">
    {/* One toolbar for the pane. Session history, saved usage and the terminal
        tools used to occupy three further bordered rows; they are now
        popovers, and the transport state is a dot with a tooltip rather than a
        full row carrying a sentence that never changes. */}
    {/* The session tabs lead the toolbar; the rest is about the terminal on screen, once there is one. */}
    <div className="flex flex-nowrap items-center gap-1.5 overflow-hidden border-b border-border px-2.5 py-1.5">
      {sessionTabs}
      {terminal && <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs" role="status" data-testid={disconnected ? 'terminal-disconnected' : 'terminal-state'} title={stateHelp}>
        {disconnected ? <WifiOff className="size-3.5 text-warning" aria-hidden="true" /> : <span aria-hidden="true" className={`size-1.5 rounded-full ${stateDotClass} ${running ? 'hidden' : ''}`} />}
        {/* Running is the normal case and the session tab's dot already says it, so the word is for screen readers only. */}
        <span className={running ? 'sr-only' : disconnected ? 'text-warning' : 'text-muted-foreground'}>{stateLabel}</span>
      </span>}
      {/* The help sentence is constant while running, so it is a tooltip
          there. Disconnected and exited need the user to react, so their
          explanation stays on screen. */}
      {terminal && (disconnected || exited) && <span className="min-w-0 truncate text-[11px] text-muted-foreground" data-testid="terminal-state-help">
        {disconnected && error ? `${stateHelp} ${error}` : stateHelp}
      </span>}
      {summary ? <div className="min-w-[8rem] flex-1">{summary}</div> : <span className="flex-1" />}
      {inspectorControls}
      {terminal && <Menu open={paneMenuOpen} onOpenChange={setPaneMenuOpen}>
        <MenuTrigger aria-label="Pane options" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" title="Open terminals, usage and terminal tools">
          <MoreHorizontal className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-64 p-1">
          {terminal.target !== 'shell' && <>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Session usage</div>
            <div className="px-2 pb-1">
              {/* Keep the landmark stable: the region exists whether or not a
                  matching conversation has been recorded yet, and only its
                  contents change. */}
              <div role="region" aria-label="CLI session usage">
                {usageSummary
                  ? <p className="text-[11px] text-muted-foreground">{usageSummary}</p>
                  : <SessionUsageDetails session={usageSession!} />}
              </div>
            </div>
            <MenuItem onClick={() => void usageHistory.refetch()} className="flex items-center gap-2 text-xs"><RefreshCw className="size-3" />Refresh usage</MenuItem>
            <div className="my-1 border-t border-border" />
          </>}
          <div className="px-1.5 py-1" onClick={event => event.stopPropagation()}>
            <MenuSearchInput aria-label="Search terminal output" placeholder="Search output" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search.current?.findNext(query); }} />
          </div>
          <MenuItem onClick={() => search.current?.findNext(query)} className="flex items-center gap-2 text-xs"><Search className="size-3" />Find next match</MenuItem>
          <MenuItem onClick={() => void copySelection()} className="flex items-center gap-2 text-xs"><Copy className="size-3" />Copy selection</MenuItem>
          <MenuItem onClick={() => setScreenReader(value => !value)} className="flex items-center gap-2 text-xs">{screenReader ? '✓ ' : '  '}Screen reader mode</MenuItem>
          <div className="my-1 border-t border-border" />
          <MenuItem onClick={() => void refresh()} className="flex items-center gap-2 text-xs"><RefreshCw className="size-3" />Refresh CLI tools</MenuItem>
          <MenuItem disabled={!target} onClick={() => void external()} className="flex items-center gap-2 text-xs"><ExternalLink className="size-3" />External terminal</MenuItem>
          <div className="my-1 border-t border-border" />
          <p className="truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={terminal.cwd}>{terminal.cwd}</p>
        </MenuPopup>
      </Menu>}
      {resumeButton}
      {terminal && disconnected && <Button size="xs" variant="outline" onClick={() => setRetry(value => value + 1)}><PlugZap className="size-3" />Reconnect</Button>}
      {terminal && !exited && terminal.state !== 'exited' && <IconButton label="End" icon={<Square />} onClick={() => void stop()} className="text-muted-foreground" />}
    </div>
    {error && (!terminal || !disconnected) && <div role="alert" className="border-b border-border px-3 py-2 text-xs text-warning break-words">{error}{retryLaunch && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void start(retryLaunch)}>Retry launch</Button>}</div>}
    {terminal && showHistory && <ResumeSessions workspace={workspace} active={active} busy={busy} status={status} fill={false} onStartNew={() => setShowHistory(false)} onResume={session => void resume({ id: crypto.randomUUID(), target: session.assistant, sessionId: session.id, cwd: session.workspacePath })} />}
    {!terminal && boundTerminalId === undefined && <p role="status" className="px-4 py-4 text-xs text-muted-foreground">Looking for running sessions…</p>}
    {!terminal && boundTerminalId !== undefined && <section aria-label="Start a CLI session" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="px-4 pb-2 pt-4">
        <div className="flex items-center gap-1">
          <h3 className="text-[13px] font-semibold text-foreground">Start a CLI</h3>
          <span className="flex-1" />
          <IconButton label="Refresh the CLI tools" icon={<RefreshCw />} onClick={() => void refresh()} className="text-muted-foreground" />
          <IconButton label="Open an external terminal" icon={<ExternalLink />} disabled={!target} onClick={() => void external()} className="text-muted-foreground" />
        </div>
        {tools.length > 0 && <div role="group" aria-label="CLI tools" className="mt-2 flex flex-wrap gap-1.5">
          {tools.map(tool => (
            <Button key={tool.id} size="sm" variant="outline" aria-label={`Start ${harnessName(tool.id)}`} disabled={busy || !status?.available}
              title={tool.id === target ? `Start ${harnessName(tool.id)}, the tool used last here` : `Start ${harnessName(tool.id)}`}
              className={tool.id === target ? 'border-primary/60' : undefined}
              onClick={() => void start({ id: crypto.randomUUID(), target: tool.id })}>
              <HarnessIcon harness={tool.id} />{harnessName(tool.id)}
            </Button>
          ))}
        </div>}
        <p role="status" className={problem || busy ? 'mt-2 text-xs text-muted-foreground' : 'sr-only'}>{busy ? 'Starting…' : problem}</p>
      </div>
      <ResumeSessions embedded workspace={workspace} active={active} busy={busy} status={status} fill onStartNew={() => undefined} onResume={session => void resume({ id: crypto.randomUUID(), target: session.assistant, sessionId: session.id, cwd: session.workspacePath })} />
    </section>}
    <div className={`relative min-h-0 flex-1 bg-[#111b18] p-2 ${terminal ? '' : 'hidden'}`} onPointerDownCapture={event => {
      if (event.button === 2) menuSelection.current = renderer.current?.getSelection() ?? '';
    }} onContextMenu={event => {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      setClipboardMenu({ x: Math.min(event.clientX - bounds.left, Math.max(0, bounds.width - 150)), y: Math.min(event.clientY - bounds.top, Math.max(0, bounds.height - 80)) });
    }}>
      {/* FitAddon measures this element's height; keep padding on its parent so the last row fits. */}
      <div ref={host} className="h-full overflow-hidden" aria-label="Interactive CLI terminal" />
      {clipboardMenu && <div className="absolute z-20 min-w-36 rounded border border-border bg-card p-1 shadow-lg" style={{ left: clipboardMenu.x, top: clipboardMenu.y }} role="menu" onKeyDown={event => { if (event.key === 'Escape') setClipboardMenu(null); }}>
        <button role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => { setClipboardMenu(null); void copySelection(menuSelection.current); menuSelection.current = ''; }}>Copy selection</button>
        <button role="menuitem" className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => void pasteClipboard()}>Paste</button>
      </div>}
    </div>
  </div>;
}
