import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { IPty } from 'node-pty';
import type { LaunchSpec } from './targets.js';
import { preparePtyHelper } from './native.js';

export type PtyProcess = Pick<IPty, 'pid' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'>;
export type PtyFactory = (launch: LaunchSpec, cwd: string, cols: number, rows: number) => Promise<PtyProcess>;
export interface TerminalClient { send(data: string): void; close(): void }
export interface TerminalInfo { id: string; workspace: string; target: string; label: string; cwd: string; sessionId?: string; startedAt: string; state: 'running' | 'exited'; exitCode?: number; exitedAt?: string }
/** A running terminal as the app-wide list shows it: where it is, whether a window shows it, when it last printed and, with no window, when it stops. */
export interface RunningTerminal extends TerminalInfo { attached: boolean; lastOutputAt?: string; stopsAt?: string }
interface Session extends TerminalInfo {
  owner: string; launchId: string; pty: PtyProcess; chunks: string[]; length: number; truncated: boolean; typed: boolean;
  client?: TerminalClient; unacked: number; paused: boolean; timer?: NodeJS.Timeout; stall?: NodeJS.Timeout;
  lastOutputMs?: number; stopsAtMs?: number;
}
const MAX_REPLAY = 512 * 1024;
const HIGH_WATER = 128 * 1024;
/** A saved conversation created within this window after a terminal started belongs to it. */
const CLAIM_SKEW_MS = 5_000;

/** The terminal ended (expired, or the backend restarted); only a new launch can continue its work. */
export class TerminalNotFoundError extends Error {
  readonly code = 'terminal_not_found';
  constructor() { super('Terminal not found in this workspace.'); }
}

export async function nativePtyAvailable(): Promise<{ available: boolean; reason?: string }> {
  try { await preparePtyHelper(); await import('node-pty'); return { available: true }; }
  catch { return { available: false, reason: 'Native terminal support could not load. Reinstall a supported ContextSpace build or rebuild node-pty for this runtime.' }; }
}
export const spawnNativePty: PtyFactory = async (launch, cwd, cols, rows) => {
  await preparePtyHelper();
  const pty = await import('node-pty').catch(() => { throw new Error('Native terminal support is unavailable. Reinstall ContextSpace or rebuild node-pty for this runtime.'); });
  return pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cwd, cols, rows, env: launch.env });
};

/** Terminate owned PTY descendants too, including foreground job process groups. */
export function terminatePty(pty: PtyProcess, platform = process.platform): void {
  if (platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/pid', String(pty.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch { /* may have exited */ }
  } else {
    try {
      const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const descendants: number[] = [];
      const visit = (pid: number) => { for (const [child, parent] of rows) if (parent === pid && child > 1) { visit(child); descendants.push(child); } };
      visit(pty.pid);
      for (const pid of descendants) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    } catch { /* still kill the PTY's group below */ }
    try { process.kill(-pty.pid, 'SIGKILL'); } catch { /* no group */ }
  }
  try { pty.kill(platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* gone */ }
}

export type OwnerActiveChecker = (owner: string) => boolean;

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<TerminalInfo>>();
  private closing = false;
  private resuming = new Set<string>();
  private ownerActiveChecker?: OwnerActiveChecker;
  constructor(private factory: PtyFactory = spawnNativePty, private terminate = terminatePty, private graceMs = 5 * 60_000, isOwnerActive?: OwnerActiveChecker) {
    this.ownerActiveChecker = isOwnerActive;
  }
  setOwnerActiveChecker(checker: OwnerActiveChecker): void {
    this.ownerActiveChecker = checker;
  }
  private info(s: Session): TerminalInfo {
    const { id, workspace, target, label, cwd, sessionId, startedAt, state, exitCode, exitedAt } = s;
    return { id, workspace, target, label, cwd, sessionId, startedAt, state, exitCode, exitedAt };
  }
  list(owner: string, workspace: string): TerminalInfo[] {
    return [...this.sessions.values()].filter(s => s.owner === owner && s.workspace === workspace).map(s => this.info(s));
  }
  /** Every running terminal of one owner, in every workspace, so the app can say where each CLI is without opening each workspace. */
  running(owner: string): RunningTerminal[] {
    return [...this.sessions.values()].filter(s => s.owner === owner && s.state === 'running').map(s => ({
      ...this.info(s),
      attached: Boolean(s.client),
      lastOutputAt: s.lastOutputMs === undefined ? undefined : new Date(s.lastOutputMs).toISOString(),
      stopsAt: s.client || s.stopsAtMs === undefined ? undefined : new Date(s.stopsAtMs).toISOString(),
    }));
  }
  hasAttached(owner: string): boolean {
    return [...this.sessions.values()].some(s => s.owner === owner && Boolean(s.client));
  }
  private owned(owner: string, workspace: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner || s.workspace !== workspace) throw new TerminalNotFoundError();
    return s;
  }
  /**
   * Bind a saved conversation to the fresh terminal that created it.
   *
   * A terminal started without a session ID learns its conversation only after
   * the harness records one. Resume requests arrive with that ID, so without
   * this binding a second process would open the same conversation.
   *
   * The match must be one-to-one. Exactly one unbound terminal of the same
   * tool and directory, running or recently exited, may have started before the
   * conversation (within a few seconds of clock skew); it must belong to the
   * requesting owner, still be running and have received input. No other
   * conversation of that tool and directory may have started since that
   * terminal did. Anything less certain stays unbound, and resume behaves as
   * before this binding existed.
   */
  claimSession(input: { owner: string; workspace: string; target: string; cwd: string; sessionId: string; createdAt: string; others: { cwd: string; createdAt: string }[] }): TerminalInfo | undefined {
    const created = Date.parse(input.createdAt);
    if (!Number.isFinite(created)) return undefined;
    const sameTool = [...this.sessions.values()].filter(s => s.target === input.target);
    if (sameTool.some(s => s.state === 'running' && s.sessionId === input.sessionId)) return undefined;
    const candidates = sameTool.filter(s => s.workspace === input.workspace && !s.sessionId && s.cwd === input.cwd && Date.parse(s.startedAt) <= created + CLAIM_SKEW_MS);
    if (candidates.length !== 1) return undefined;
    const [terminal] = candidates;
    if (terminal.owner !== input.owner || terminal.state !== 'running' || !terminal.typed) return undefined;
    const started = Date.parse(terminal.startedAt);
    if (input.others.some(other => other.cwd === input.cwd && Date.parse(other.createdAt) >= started - CLAIM_SKEW_MS)) return undefined;
    terminal.sessionId = input.sessionId;
    return this.info(terminal);
  }
  async create(input: { owner: string; workspace: string; cwd: string; target: string; sessionId?: string; launchId: string; launch: LaunchSpec }): Promise<TerminalInfo> {
    if (this.closing) throw new Error('Terminal service is shutting down.');
    const key = `${input.owner}:${input.workspace}:${input.launchId}`;
    const existing = [...this.sessions.values()].find(s => s.owner === input.owner && s.workspace === input.workspace && s.launchId === input.launchId);
    if (existing) return this.info(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;
    // Keep saved conversations single-writer even across separate browser owners.
    // Reusing a running terminal needs no capacity, so check it before the limit.
    const resumeKey = input.sessionId ? `${input.target}:${input.sessionId}` : undefined;
    const running = [...this.sessions.values()].find(s => s.state === 'running' && s.target === input.target && s.sessionId === input.sessionId && !!input.sessionId);
    if (running?.owner === input.owner && running.workspace === input.workspace) return this.info(running);
    if (this.sessions.size + this.pending.size >= 32 || this.list(input.owner, input.workspace).filter(s => s.state === 'running').length + this.pending.size >= 8) throw new Error('Terminal limit reached. End an existing session first.');
    if (resumeKey && this.resuming.has(resumeKey)) throw new Error('This saved conversation is already starting.');
    if (input.sessionId && [...this.sessions.values()].some(s => s.state === 'running' && s.target === input.target && s.sessionId === input.sessionId)) throw new Error('This saved conversation already has a running terminal.');
    if (resumeKey) this.resuming.add(resumeKey);
    const startedAt = new Date().toISOString();
    const promise = (async () => {
      const pty = await this.factory(input.launch, input.cwd, 80, 24);
      if (this.closing) { this.terminate(pty); throw new Error('Terminal service is shutting down.'); }
      const s: Session = { id: randomUUID(), workspace: input.workspace, owner: input.owner, cwd: input.cwd, target: input.target, sessionId: input.sessionId, startedAt, launchId: input.launchId, label: input.launch.label, pty, state: 'running', chunks: [], length: 0, truncated: false, typed: false, unacked: 0, paused: false };
      this.sessions.set(s.id, s);
      pty.onData(data => this.output(s, data));
      pty.onExit(({ exitCode }) => { s.state = 'exited'; s.exitCode = exitCode; s.exitedAt = new Date().toISOString(); this.send(s, { type: 'exit', exitCode, exitedAt: s.exitedAt }); this.expire(s); });
      this.expire(s);
      return this.info(s);
    })();
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); if (resumeKey) this.resuming.delete(resumeKey); }
  }
  private expire(s: Session) {
    clearTimeout(s.timer);
    s.stopsAtMs = Date.now() + this.graceMs;
    s.timer = setTimeout(() => {
      if (!this.closing && s.state === 'running' && this.ownerActiveChecker?.(s.owner)) {
        this.expire(s);
        return;
      }
      if (s.state === 'running') this.terminate(s.pty);
      clearTimeout(s.stall);
      s.client?.close();
      this.sessions.delete(s.id);
    }, this.graceMs);
    s.timer.unref();
  }
  private send(s: Session, message: object) {
    try { s.client?.send(JSON.stringify(message)); } catch { if (s.client) this.detach(s.owner, s.workspace, s.id, s.client); }
  }
  private output(s: Session, data: string) {
    s.lastOutputMs = Date.now();
    // Split large native events to bound WebSocket frame size and replay chunks.
    for (let at = 0; at < data.length; at += 16_384) {
      const chunk = data.slice(at, at + 16_384);
      s.chunks.push(chunk); s.length += chunk.length;
      while (s.length > MAX_REPLAY && s.chunks.length) { s.length -= s.chunks.shift()!.length; s.truncated = true; }
      if (s.client) { s.unacked += chunk.length; this.send(s, { type: 'output', data: chunk }); }
    }
    this.flow(s);
  }
  private flow(s: Session) {
    if (s.state !== 'running') return;
    const pause = !!s.client && s.unacked >= HIGH_WATER;
    if (pause && !s.paused) {
      s.pty.pause(); s.paused = true;
      s.stall = setTimeout(() => { const client = s.client; if (client) { this.detach(s.owner, s.workspace, s.id, client); client.close(); } }, 30_000);
      s.stall.unref();
    } else if (!pause && s.paused) { clearTimeout(s.stall); s.pty.resume(); s.paused = false; }
  }
  attach(owner: string, workspace: string, id: string, client: TerminalClient): void {
    const s = this.owned(owner, workspace, id);
    if (s.client && s.client !== client) {
      // A reloaded or moved ContextSpace window may leave its old WebSocket
      // attached until TCP notices it disappeared. Replace that connection;
      // control() rejects any late input from the previous client.
      const previous = s.client;
      this.detach(owner, workspace, id, previous);
      try { previous.close(); } catch { /* the stale connection is already gone */ }
    }
    clearTimeout(s.timer); s.stopsAtMs = undefined; s.client = client; s.unacked = s.length;
    this.send(s, { type: 'ready', terminal: this.info(s), truncated: s.truncated });
    for (const data of s.chunks) this.send(s, { type: 'output', data });
    this.send(s, { type: 'replayed' });
    if (s.state === 'exited') { this.send(s, { type: 'exit', exitCode: s.exitCode, exitedAt: s.exitedAt }); this.expire(s); }
    this.flow(s);
  }
  detach(owner: string, workspace: string, id: string, client: TerminalClient) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner || s.workspace !== workspace || s.client !== client) return;
    s.client = undefined; s.unacked = 0; this.flow(s); this.expire(s);
  }
  control(owner: string, workspace: string, id: string, client: TerminalClient, message: unknown) {
    const s = this.owned(owner, workspace, id);
    if (s.client !== client) throw new Error('Terminal connection no longer owns input.');
    if (!message || typeof message !== 'object') throw new Error('Invalid terminal message.');
    const m = message as Record<string, unknown>;
    if (m.type === 'ack' && Number.isSafeInteger(m.count) && (m.count as number) > 0 && (m.count as number) <= s.unacked) {
      s.unacked -= m.count as number; this.flow(s); return;
    }
    if (s.state !== 'running') throw new Error('This terminal has exited.');
    if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 16_384) { s.pty.write(m.data); s.typed = true; return; }
    if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && Number(m.cols) >= 2 && Number(m.cols) <= 500 && Number(m.rows) >= 1 && Number(m.rows) <= 300) { s.pty.resize(Number(m.cols), Number(m.rows)); return; }
    throw new Error('Invalid or oversized terminal message.');
  }
  stop(owner: string, workspace: string, id: string) {
    const s = this.owned(owner, workspace, id);
    if (s.state === 'running') { this.terminate(s.pty); s.state = 'exited'; s.exitedAt = new Date().toISOString(); this.send(s, { type: 'exit', exitCode: null, exitedAt: s.exitedAt }); }
    this.expire(s);
  }
  dispose() {
    this.closing = true;
    for (const s of this.sessions.values()) { clearTimeout(s.timer); clearTimeout(s.stall); if (s.state === 'running') this.terminate(s.pty); s.client?.close(); }
    this.sessions.clear();
  }
}
