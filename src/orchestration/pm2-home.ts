/**
 * @module orchestration/pm2-home
 * Where PM2 keeps its daemon files, and whether a daemon is alive there.
 * Reading the process list must never start a God Daemon: `pm2 jlist` starts
 * one when none answers, and when the socket path is too long for a Unix
 * socket every poll starts another that can never be reached.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Longest Unix socket path in bytes (sun_path is 108 including the NUL). */
export const UNIX_SOCKET_PATH_LIMIT = 107;

/** PM2 home as PM2 resolves it: `PM2_HOME`, else `~/.pm2`. */
export function resolvePm2Home(env: NodeJS.ProcessEnv = process.env): string {
  return env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2');
}

/** The socket path that is too long for a Unix socket, or null when both fit. Not applicable on Windows (named pipes). */
export function overlongPm2SocketPath(home: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  for (const name of ['rpc.sock', 'pub.sock']) {
    const sock = path.join(home, name);
    if (Buffer.byteLength(sock) > UNIX_SOCKET_PATH_LIMIT) return sock;
  }
  return null;
}

/** Throws a clear error when PM2 could not create its sockets under the home in use. */
export function assertPm2HomeUsable(home: string = resolvePm2Home()): void {
  const sock = overlongPm2SocketPath(home);
  if (sock) {
    throw new Error(
      `PM2 cannot run here: its socket path is too long for a Unix socket (${Buffer.byteLength(sock)} bytes, limit ${UNIX_SOCKET_PATH_LIMIT}): ${sock}. Set PM2_HOME to a shorter path, for example /tmp/pm2.`,
    );
  }
}

/**
 * Whether a PM2 daemon is alive for this home: `pm2.pid` names an existing
 * process and `rpc.sock` exists. EPERM from the signal probe means the process
 * exists. On Windows the sockets are named pipes, so this is not checked.
 */
export function isPm2DaemonAlive(home: string = resolvePm2Home()): boolean {
  if (process.platform === 'win32') return true;
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
    }
    fs.accessSync(path.join(home, 'rpc.sock'));
    return true;
  } catch {
    return false;
  }
}
