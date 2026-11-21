/**
 * @module core/older-writers
 * Finds a ContextSpace that does not know the workspace database and could still write a workspace's old files: the
 * check `ctxspace plan migrate` makes before it moves anything (v5 DB3.2 and v6 point 2 of the design).
 *
 * A ContextSpace "knows the database" when its code has `core/workspace-db-switch.js` beside its entry point: that
 * module is what makes every old writer refuse once a workspace is moved. Where it looks:
 * 1. The workspace's own command line (`.contextspace/bin/ctxspace` and its siblings), which every AI in the workspace
 *    runs: the backend it points at.
 * 2. The workspace's lock files (the plan, the Board, the state, the seen file, Git and mutation locks): a live process
 *    other than this one that holds one is writing the workspace right now.
 * 3. Running processes (Linux: /proc; macOS: `ps`): a ContextSpace server (`ui`, or the desktop app's backend) that
 *    uses the same ContextSpace home as this command, or any other ContextSpace command whose folder is inside the
 *    workspace. Windows has no cheap process list with command lines, so there only 1 and 2 apply, and the rule holds
 *    that the installed app is updated before its workspaces move.
 *
 * Each finding says what was found and how to stop it. Reading only: nothing is written or signalled.
 */

import { execFile } from 'node:child_process';
import { launcherEntry } from './workspace-tools.js';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface OlderWriter {
  /** What it is, in plain words. */
  what: string;
  /** Where it was found (a file, a process). */
  found: string;
  /** How to stop it. */
  stop: string;
}

export interface ProcessInfo {
  pid: number;
  /** The command line, split into arguments where the platform says so; otherwise one string in `args[0]`. */
  args: string[];
  /** The process's folder, when the platform tells it. */
  cwd?: string | null;
  /** When the process started (ms since the epoch), when the platform tells it (Linux). */
  startedAt?: number | null;
  /** Its environment's ContextSpace home settings, when the platform tells them. */
  env?: { HOME?: string; CONTEXTSPACE_HOME?: string; NEXUSFLOW_HOME?: string } | null;
}

export interface OlderWriterDeps {
  /** Running processes; [] where the platform cannot say. */
  processes: () => Promise<ProcessInfo[]>;
  pidAlive: (pid: number) => boolean;
  selfPid: number;
  /** This command's environment, for the ContextSpace home it uses. */
  env: NodeJS.ProcessEnv;
  /** The command line (and folder) of one process, when the platform tells it (Linux). */
  commandOf: (pid: number) => Pick<ProcessInfo, 'args' | 'cwd' | 'startedAt'> | null;
}

const LAUNCHERS = ['ctxspace', 'contextspace', 'ctxspace.cmd', 'contextspace.cmd'];
/** Workspace-relative, with `/`: the locks ContextSpace's writers of this workspace take. */
const LOCKS = [
  '.contextspace/plan-file.lock', '.contextspace-planning.lock', '.contextspace-plan.lock', '.contextspace/board.lock', '.contextspace/state.lock',
  '.contextspace/seen.lock', '.contextspace/workspace-git.lock', '.contextspace/mutation.lock',
];
/** A backend entry point as a process names it: absolute, or relative to its folder (`node dist/index.js ui`). */
const ENTRY = /(?:^|[\\/])dist[\\/](index|desktop-server)\.js$/;

/** The entry point a process runs, as an absolute path: a relative one is resolved against the process's own folder, never this command's. Null when it is relative and that folder is unknown. */
function entryOf(proc: Pick<ProcessInfo, 'args' | 'cwd'>): { arg: string; entry: string | null } | null {
  const arg = proc.args.find((a) => ENTRY.test(a));
  if (!arg) return null;
  if (path.isAbsolute(arg)) return { arg, entry: arg };
  return { arg, entry: proc.cwd ? path.resolve(proc.cwd, arg) : null };
}

/** Whether a process's arguments name the workspace at `root` (`mcp run <root>`, `-w <root>`, `--workspace=<root>`). */
function namesWorkspace(proc: Pick<ProcessInfo, 'args' | 'cwd'>, after: string[], root: string): boolean {
  for (const raw of after) {
    const value = raw.startsWith('--workspace=') ? raw.slice('--workspace='.length) : raw;
    if (!value || value.startsWith('-')) continue;
    const candidate = path.isAbsolute(value) ? value : proc.cwd && /[\\/]|^\.\.?$/.test(value) ? path.resolve(proc.cwd, value) : null;
    if (candidate && inside(real(candidate), root)) return true;
  }
  // `ps` on macOS joins the arguments with spaces, so a path with a space in it arrives in pieces.
  const joined = ` ${after.join(' ')} `;
  return joined.includes(` ${root} `) || joined.includes(` ${root}/`) || joined.includes(`=${root} `);
}

/** The ContextSpace backend `entry` belongs to knows the workspace database. */
export function knowsDatabase(entry: string, startedAt?: number | null): boolean {
  const file = path.join(path.dirname(entry), 'core', 'workspace-db-switch.js');
  let changed: number;
  try { changed = statSync(file).mtimeMs; } catch { return false; }
  // A process keeps running the code it loaded when it started: files updated (a rebuild, an install) after it started
  // say nothing about it. A second of slack for file-time rounding.
  return startedAt === undefined || startedAt === null || changed <= startedAt + 1000;
}

/** When a process started, on Linux: its start in clock ticks after boot (/proc/<pid>/stat) plus the boot time. */
function linuxStartedAt(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "pid (comm) ": field 3 is fields[0]
    const ticks = Number(fields[19]); // field 22: starttime
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return null;
    return boot * 1000 + (ticks / 100) * 1000; // USER_HZ is 100 on Linux
  } catch {
    return null;
  }
}

/** A ContextSpace backend entry point (its dist folder holds the plan store), not just any `dist/index.js`. */
function isContextSpaceEntry(entry: string): boolean {
  return ENTRY.test(entry) && existsSync(path.join(path.dirname(entry), 'core', 'plan-file-store.js'));
}

function versionOf(entry: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'an older version';
  } catch {
    return 'an older version';
  }
}

const real = (p: string): string => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** The ContextSpace home an environment uses, the way the app picks it (its env setting, else ~/.contextspace). */
function homeOf(env: { HOME?: string; USERPROFILE?: string; CONTEXTSPACE_HOME?: string; NEXUSFLOW_HOME?: string }): string | null {
  const set = env.CONTEXTSPACE_HOME?.trim() || env.NEXUSFLOW_HOME?.trim();
  if (set) return real(set);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? real(path.join(home, '.contextspace')) : null;
}

function linuxProcesses(): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return []; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!args.some((a) => ENTRY.test(a))) continue;
      let cwd: string | null = null;
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* not ours to see */ }
      let env: ProcessInfo['env'] = null;
      try {
        const pairs = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const pick = (key: string) => pairs.find((p) => p.startsWith(`${key}=`))?.slice(key.length + 1);
        env = { HOME: pick('HOME'), CONTEXTSPACE_HOME: pick('CONTEXTSPACE_HOME'), NEXUSFLOW_HOME: pick('NEXUSFLOW_HOME') };
      } catch { /* not ours to see */ }
      out.push({ pid, args, cwd, env, startedAt: linuxStartedAt(pid) });
    } catch { /* gone, or not ours */ }
  }
  return out;
}

function macProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) return [];
        // `ps` joins the arguments with spaces, and paths may hold spaces ("Application Support"): the entry is the
        // stretch from an argument start to `dist/<entry>.js` that names a file that is really there.
        const command = match[2]!;
        const end = /(?:^|[\s\\/])dist[\\/](?:index|desktop-server)\.js(?=\s|$)/.exec(command);
        if (!end) return [];
        const stop = end.index + end[0].length;
        for (let start = 0; start <= end.index + 1; start += 1) {
          if (start > 0 && command[start - 1] !== ' ') continue;
          const entry = command.slice(start, stop);
          // an absolute entry must be a file that is there; a relative one (`dist/index.js`) has no spaces, and ps gives no folder to resolve it against
          if (path.isAbsolute(entry) ? existsSync(entry) : !/\s/.test(entry) && ENTRY.test(entry)) {
            return [{ pid: Number(match[1]), args: [entry, ...command.slice(stop).trim().split(/\s+/).filter(Boolean)] }];
          }
        }
        return [];
      }));
    });
  });
}

export const defaultDeps: OlderWriterDeps = {
  processes: async () => (process.platform === 'linux' ? linuxProcesses() : process.platform === 'darwin' ? macProcesses() : []),
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  selfPid: process.pid,
  env: process.env,
  commandOf: (pid) => {
    if (process.platform !== 'linux') return null;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      let cwd: string | null = null;
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* not ours to see */ }
      return { args, cwd, startedAt: linuxStartedAt(pid) };
    } catch { return null; }
  },
};

/** Every ContextSpace that could still write the old files of the workspace at `root` (its real path). */
export async function findOlderWriters(root: string, deps: OlderWriterDeps = defaultDeps): Promise<OlderWriter[]> {
  const found: OlderWriter[] = [];
  const dot = path.join(root, '.contextspace');

  // 1. the workspace's command line: the four launchers, read the way generateWorkspaceTools writes them (shell and .cmd)
  const byEntry = new Map<string, { entry: string; names: string[] }>();
  for (const name of LAUNCHERS) {
    const rel = `.contextspace/bin/${name}`;
    let text: string;
    try { text = readFileSync(path.join(dot, 'bin', name), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      text = '';
    }
    const entry = launcherEntry(text);
    if (entry === null) {
      // Not a launcher ContextSpace wrote, so it cannot tell what it runs: it refuses rather than guess.
      found.push({
        what: 'The workspace\'s command line is not in a form ContextSpace writes, so it cannot tell which ContextSpace it runs, or whether that one knows the workspace database',
        found: rel,
        stop: 'Move that file out of .contextspace/bin/ (keep it if it is yours), open this workspace in the updated ContextSpace app once so it writes its own launchers, then migrate again',
      });
      continue;
    }
    if (!existsSync(entry)) continue; // a launcher whose program is gone cannot write anything (it stops with "missing")
    const key = real(entry);
    const seen = byEntry.get(key);
    if (seen) seen.names.push(rel); else byEntry.set(key, { entry, names: [rel] });
  }
  for (const { entry, names } of byEntry.values()) {
    if (knowsDatabase(entry)) continue;
    found.push({
      what: `The workspace's command line runs ContextSpace ${versionOf(entry)}, which does not know the workspace database. Every AI in this workspace runs it, and it would keep writing the old files`,
      found: `${names.join(', ')} → ${entry}`,
      stop: 'Update the ContextSpace app, then open this workspace in it once (that points the command line at the new version), and migrate again',
    });
  }

  // 2. lock files held by another live process
  for (const name of LOCKS) {
    let pid: number | undefined;
    try { pid = (JSON.parse(readFileSync(path.join(root, ...name.split('/')), 'utf8')) as { pid?: unknown }).pid as number | undefined; } catch { continue; }
    if (typeof pid !== 'number' || pid === deps.selfPid || !deps.pidAlive(pid)) continue;
    const command = deps.commandOf(pid);
    const entry = command ? entryOf(command)?.entry ?? null : null;
    if (entry && knowsDatabase(entry, command?.startedAt)) continue; // a ContextSpace that knows the database: the move just waits for its lock
    found.push({
      what: entry ? `ContextSpace ${versionOf(entry)} is writing this workspace right now, and it does not know the workspace database` : 'Another program is writing this workspace right now, and ContextSpace cannot tell whether it knows the workspace database',
      found: `${name} is held by process ${pid}`,
      stop: 'Let it finish (or close it), then migrate again',
    });
  }

  // 3. running ContextSpace processes that do not know the database
  const ourHome = homeOf(deps.env);
  for (const proc of await deps.processes()) {
    if (proc.pid === deps.selfPid) continue;
    const found1 = entryOf(proc);
    if (!found1) continue;
    const { arg, entry } = found1;
    const after = proc.args.slice(proc.args.indexOf(arg) + 1);
    const named = namesWorkspace(proc, after, root);
    if (entry) {
      if (!isContextSpaceEntry(entry) || knowsDatabase(entry, proc.startedAt)) continue;
    } else if (!named) {
      continue; // a relative entry with no folder to resolve it against (macOS): only one that names this workspace is ours to report
    }
    const stale = entry !== null && knowsDatabase(entry); // its files know the database, but it started before they did
    const version = entry ? `ContextSpace ${versionOf(entry)}` : 'ContextSpace';
    const knows = !entry ? 'ContextSpace cannot tell whether it knows the workspace database'
      : stale ? 'it started before its files were updated to know the workspace database, so the code it runs does not know it (restart it)'
        : 'it does not know the workspace database';
    const shown = entry ?? arg;
    const server = /desktop-server\.js$/.test(arg) || after[0] === 'ui';
    if (server) {
      const theirs = proc.env ? homeOf(proc.env) : null;
      if (!named && theirs && ourHome && theirs !== ourHome) continue; // a server of another ContextSpace home does not serve this workspace
      found.push({
        what: `A ${version} server is running (${/desktop-server\.js$/.test(arg) ? 'the desktop app' : '`ctxspace ui`'}), and ${knows}; it serves every workspace of this ContextSpace home and would keep writing the old files`,
        found: `process ${proc.pid}: ${shown}${after.length ? ` ${after.join(' ')}` : ''}`,
        stop: 'Quit the ContextSpace app (or stop `ctxspace ui`), update it, then migrate again',
      });
    } else if (named || (proc.cwd && inside(real(proc.cwd), root))) {
      found.push({
        what: `A ${version} command is running on this workspace (${after.slice(0, 2).join(' ') || 'a command'}), and ${knows}`,
        found: `process ${proc.pid}: ${shown} ${after.join(' ')}`.trim(),
        stop: 'Close the AI tool or terminal that runs it, then migrate again',
      });
    }
  }
  return found;
}

/** For messages: the user's home folder shortened to ~. */
export const shortPath = (p: string): string => { const home = os.homedir(); return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p; };
