// Always same-origin, including Vite's terminal-only development proxy.
const API_BASE = '';

export interface TerminalInfo { id: string; workspace: string; target: string; label: string; cwd: string; sessionId?: string; startedAt?: string; state: 'running' | 'exited'; exitCode?: number; exitedAt?: string }
/** A running terminal in any workspace (POST /api/terminals/running). */
export interface RunningTerminal extends TerminalInfo { attached: boolean; lastOutputAt?: string; stopsAt?: string }
/**
 * A request to the session tabs: start `target` (resuming `sessionId`, or with `prompt` as the first message of a new
 * session), or, with `terminalId`, show that running terminal.
 */
export interface TerminalLaunch { id: string; target: string; sessionId?: string; cwd?: string; prompt?: string; terminalId?: string }
export interface TerminalStatus { available: boolean; reason?: string; targets: { id: string; name: string; available: boolean; reason: string | null }[]; sessions: TerminalInfo[] }
let bootstrap: Promise<string> | undefined;
let expires = 0;
export async function terminalToken(): Promise<string> {
  if (Date.now() >= expires) bootstrap = undefined;
  if (!bootstrap) {
    expires = Date.now() + 4 * 60_000;
    bootstrap = fetch(`${API_BASE}/api/terminals/bootstrap`, { method: 'POST', credentials: 'include', headers: { 'x-contextspace-terminal': 'bootstrap' } }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not connect to the local terminal service.');
      // A bootstrap can reuse a token near expiry. Do not cache it past the
      // server's deadline or a later WebSocket reconnect will be rejected.
      expires = Math.min(expires, Number(body.expiresAt) - 5000);
      return body.token as string;
    }).catch(error => { bootstrap = undefined; throw error; });
  }
  return bootstrap;
}
export function terminalRequest<T>(workspace: string, action: string, body: object = {}): Promise<T> {
  return terminalPost<T>(`${encodeURIComponent(workspace)}/${action}`, body);
}
/** This browser's running terminals in every workspace. */
export async function runningTerminals(): Promise<RunningTerminal[]> {
  return (await terminalPost<{ sessions: RunningTerminal[] }>('running')).sessions;
}
async function terminalPost<T>(path: string, body: object = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await terminalToken();
    const response = await fetch(`${API_BASE}/api/terminals/${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-contextspace-terminal': token }, body: JSON.stringify(body) });
    const result = await response.json();
    if (response.status === 403 && attempt === 0) { bootstrap = undefined; expires = 0; continue; }
    if (!response.ok) throw new Error(result.error || 'Terminal request failed.');
    return result as T;
  }
  throw new Error('Terminal authorization expired. Reconnect.');
}
export function terminalSocketUrl() {
  const url = new URL('/ws/terminal', API_BASE || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
