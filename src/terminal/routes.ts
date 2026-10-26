import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { assertWorkspaceActive } from '../core/archive-guard.js';
import { checkGenerationLock } from '../core/generation-lock.js';
import { upgradeWorkspaceToRunningVersion } from '../core/refresh.js';
import { loadWorkspaceManifest } from '../core/workspace.js';
import { canOpenCodexSessionInWorkspace, canTransferClaudeSessionInWorkspace, findSessions } from '../utils/session-finder.js';
import { TerminalManager, TerminalNotFoundError, nativePtyAvailable, type TerminalClient } from './manager.js';
import { listTerminalTargets, resolveLaunch, withWorkspaceCli } from './targets.js';
import { isCliHarnessId } from '../utils/cli-harnesses.js';

const COOKIE = 'contextspace_terminal_owner';
const HEADER = 'x-contextspace-terminal';
const TOKEN_TTL = 5 * 60_000;
const OWNER_TTL = 24 * 60 * 60_000;
const uuid = z.string().uuid();
const workspaceId = z.string().min(1).max(200);
/**
 * A first message for a new session: one line of plain text. Control characters and line breaks are
 * removed, so it cannot type anything beyond itself.
 */
// eslint-disable-next-line no-control-regex
const firstMessage = z.string().max(1000).transform(text => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).pipe(z.string().min(1).max(1000));
export const createSchema = z.object({ launchId: uuid, target: z.string().refine(id => id === 'shell' || isCliHarnessId(id)), cwd: z.string().max(4096).optional(), sessionId: uuid.optional(), prompt: firstMessage.optional() }).strict()
  .refine(input => !(input.prompt && input.sessionId), 'A resumed conversation carries on where it was; it takes no first message.');

export function trustedTerminalOrigin(origin: string | undefined, requestUrl: string, developmentOrigin = process.env.CONTEXTSPACE_DASHBOARD_ORIGIN): boolean {
  if (!origin) return false;
  try {
    const supplied = new URL(origin), request = new URL(requestUrl);
    const local = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    if (!local(supplied) || !local(request) || supplied.origin !== origin) return false;
    return origin === request.origin || (!!developmentOrigin && origin === new URL(developmentOrigin).origin);
  } catch { return false; }
}
export async function containedTerminalCwd(root: string, requested = '.'): Promise<string> {
  const base = await fs.realpath(root);
  const cwd = await fs.realpath(path.resolve(base, requested));
  const relative = path.relative(base, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(cwd)).isDirectory()) throw new Error('Terminal directory must be inside this workspace.');
  return cwd;
}

export class TerminalAccess {
  private owners = new Map<string, { token: string; expires: number; lastSeen: number }>();
  bootstrap(cookie?: string) {
    const now = Date.now();
    for (const [id, item] of this.owners) if (item.lastSeen + OWNER_TTL < now) this.owners.delete(id);
    let owner = cookie && this.owners.has(cookie) ? cookie : undefined;
    if (!owner) {
      if (this.owners.size >= 128) throw new Error('Too many terminal browser sessions. Restart the local server.');
      owner = randomBytes(32).toString('hex');
    }
    let item = this.owners.get(owner);
    // Reuse a live token so parallel workspace panels do not invalidate one another.
    if (!item || item.expires <= now) item = { token: randomBytes(32).toString('hex'), expires: now + TOKEN_TTL, lastSeen: now };
    item.lastSeen = now; this.owners.set(owner, item);
    return { owner, token: item.token, expiresAt: item.expires };
  }
  validate(owner: string | undefined, token: unknown): owner is string {
    if (!owner || typeof token !== 'string') return false;
    const item = this.owners.get(owner);
    if (!item || item.expires <= Date.now() || token !== item.token) return false;
    item.lastSeen = Date.now(); return true;
  }
  touch(owner: string): void {
    const item = this.owners.get(owner);
    if (item) item.lastSeen = Date.now();
  }
  isActive(owner: string, maxInactiveMs = TOKEN_TTL): boolean {
    const item = this.owners.get(owner);
    if (!item) return false;
    return Date.now() - item.lastSeen < maxInactiveMs;
  }
}

export const terminalManager = new TerminalManager();
export function registerTerminalRoutes(app: Hono, upgrade: UpgradeWebSocket<any, any>, resolveWorkspace: (id: string) => Promise<string | null>, manager = terminalManager) {
  const access = new TerminalAccess();
  manager.setOwnerActiveChecker?.((owner) => access.isActive(owner) || manager.hasAttached(owner));
  const boundary = (c: Context) => {
    const origin = c.req.header('origin');
    // Same-origin fetch need not send Origin; Fetch Metadata plus our custom
    // header supplies a browser-only boundary. Cross-origin dev uses an exact opt-in.
    return origin ? trustedTerminalOrigin(origin, c.req.url) : c.req.header('sec-fetch-site') === 'same-origin';
  };
  app.use('/api/terminals/*', bodyLimit({ maxSize: 16_384 }));
  app.use('/api/terminals/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!boundary(c) || !c.req.header(HEADER)) return c.json({ error: 'Terminal access requires the local ContextSpace window.' }, 403);
    if (c.req.path === '/api/terminals/bootstrap') return next();
    if (!access.validate(getCookie(c, COOKIE), c.req.header(HEADER))) return c.json({ error: 'Terminal access expired. Reconnect from ContextSpace.' }, 403);
    return next();
  });
  app.post('/api/terminals/bootstrap', c => {
    try {
      const session = access.bootstrap(getCookie(c, COOKIE));
      setCookie(c, COOKIE, session.owner, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: OWNER_TTL / 1000, secure: new URL(c.req.url).protocol === 'https:' });
      return c.json({ token: session.token, expiresAt: session.expiresAt });
    } catch (error) { return c.json({ error: (error as Error).message }, 429); }
  });
  const rootFor = async (id: string) => {
    const root = await resolveWorkspace(workspaceId.parse(id));
    if (!root) throw new Error('Workspace not found.');
    return root;
  };
  // Every running terminal of this browser, across workspaces: the sidebar says where each CLI is from this.
  app.post('/api/terminals/running', c => c.json({ sessions: manager.running(getCookie(c, COOKIE)!) }));
  app.post('/api/terminals/:workspace/status', async c => {
    try {
      const id = c.req.param('workspace'); await rootFor(id);
      return c.json({ ...await nativePtyAvailable(), targets: listTerminalTargets(), sessions: manager.list(getCookie(c, COOKIE)!, id) });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  app.post('/api/terminals/:workspace/create', async c => {
    try {
      const id = c.req.param('workspace'), root = await rootFor(id);
      const input = createSchema.parse(await c.req.json());
      // An archived workspace keeps a readable record only; stopping its terminals stays allowed, so leftovers can be cleaned up.
      assertWorkspaceActive(await loadWorkspaceManifest(root), 'start assistant sessions');
      await upgradeWorkspaceToRunningVersion(root);
      await checkGenerationLock(root, { markDocuments: true });
      let cwd = await containedTerminalCwd(root, input.cwd);
      if (input.sessionId) {
        const manifest = await loadWorkspaceManifest(root);
        const repos = (await Promise.all((manifest?.repos ?? []).map(repo => containedTerminalCwd(root, path.basename(repo)).catch(() => null)))).filter((repo): repo is string => !!repo);
        const checker = input.target === 'codex' ? canOpenCodexSessionInWorkspace : input.target === 'claude' ? canTransferClaudeSessionInWorkspace : null;
        if (checker && !await checker(root, repos, input.sessionId)) throw new Error('Saved session ownership could not be verified for this workspace and harness.');
        const sessions = await findSessions(root, repos);
        const found = sessions.find(s => s.assistant === input.target && s.id === input.sessionId);
        if (!found?.recordedCwd) throw new Error('Saved session ownership could not be verified. Open the harness and use its own session picker.');
        if (found.threadKind === 'subagent') throw new Error('This is a subagent session. Resume its main conversation instead.');
        cwd = await containedTerminalCwd(root, found.recordedCwd);
        // A conversation started in a fresh terminal here attaches to that terminal.
        // Other main conversations of this tool make the match ambiguous; see claimSession.
        const others = await Promise.all(sessions
          .filter(s => s.assistant === input.target && s.id !== input.sessionId && s.threadKind !== 'subagent' && s.recordedCwd)
          .map(async s => ({ cwd: await containedTerminalCwd(root, s.recordedCwd!).catch(() => ''), createdAt: s.createdAt })));
        manager.claimSession({ owner: getCookie(c, COOKIE)!, workspace: id, target: input.target, cwd, sessionId: input.sessionId, createdAt: found.createdAt, others: others.filter(other => other.cwd) });
      }
      const terminal = await manager.create({ owner: getCookie(c, COOKIE)!, workspace: id, cwd, target: input.target, sessionId: input.sessionId, launchId: input.launchId, launch: withWorkspaceCli(resolveLaunch(input.target, input.sessionId, undefined, undefined, input.prompt), root) });
      return c.json({ terminal });
    } catch (error) { return c.json({ error: error instanceof z.ZodError ? 'Invalid terminal launch parameters.' : (error as Error).message }, 400); }
  });
  app.post('/api/terminals/:workspace/:id/stop', async c => {
    try {
      const workspace = c.req.param('workspace'); await rootFor(workspace);
      manager.stop(getCookie(c, COOKIE)!, workspace, uuid.parse(c.req.param('id')));
      return c.json({ success: true });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });
  app.get('/ws/terminal', async (c, next) => {
    // node-ws synthesizes c.req.url against http://localhost, losing the real
    // port. The browser's Host header retains the exact upgrade destination.
    const upgradeUrl = `http://${c.req.header('host') ?? new URL(c.req.url).host}/ws/terminal`;
    if (!trustedTerminalOrigin(c.req.header('origin'), upgradeUrl)) return c.text('Forbidden', 403);
    const owner = getCookie(c, COOKIE);
    if (!owner) return c.text('Forbidden', 403);
    let client: TerminalClient | undefined, workspace = '', id = '', attached = false, connecting = false, closed = false;
    let deadline: NodeJS.Timeout;
    return upgrade(() => ({
      onOpen(_event, ws) {
        client = { send: data => ws.send(data), close: () => ws.close(1008) };
        deadline = setTimeout(() => ws.close(1008), 5000); deadline.unref();
      },
      async onMessage(event, ws) {
        try {
          if (typeof event.data !== 'string' || event.data.length > 20_000) throw new Error('Invalid terminal frame.');
          const message = JSON.parse(event.data);
          if (!attached) {
            if (connecting) throw new Error('Terminal attachment is pending.');
            if (message.type !== 'attach' || !access.validate(owner, message.token)) throw new Error('Terminal access expired. Reconnect from ContextSpace.');
            connecting = true;
            workspace = workspaceId.parse(message.workspace); id = uuid.parse(message.id);
            await rootFor(workspace);
            if (closed) return;
            manager.attach(owner, workspace, id, client!); attached = true; clearTimeout(deadline);
          } else {
            access.touch(owner);
            manager.control(owner, workspace, id, client!, message);
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: error instanceof z.ZodError ? 'Invalid terminal attachment.' : (error as Error).message, ...(error instanceof TerminalNotFoundError ? { code: error.code } : {}) }));
          ws.close(1008);
        }
      },
      onClose() { closed = true; clearTimeout(deadline); if (client && attached) manager.detach(owner, workspace, id, client); },
      onError() { closed = true; clearTimeout(deadline); if (client && attached) manager.detach(owner, workspace, id, client); },
    }))(c, next);
  });
}
