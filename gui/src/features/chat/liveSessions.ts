/**
 * Where each CLI is running, from the server's own list of running terminals. Pure, so the rules can be tested
 * without a DOM. A workspace with a CLI is marked in the sidebar, on its open session and in the rail, so the
 * developer never has to open a workspace to learn whether something is running in it.
 */

import { harnessName } from '../../components/icons/HarnessIcon.js';
import type { RunningTerminal } from '../terminal/client.js';

/** Output this recent counts as working. A CLI at its prompt prints nothing; one that is thinking keeps printing. */
export const WORKING_WINDOW_MS = 8_000;

/**
 * - waiting: the AI asked something and waits for the developer.
 * - closing: no window shows it any more, so the server stops it soon.
 * - working: it printed something a moment ago.
 * - idle: it is at its prompt.
 */
export type LiveState = 'waiting' | 'closing' | 'working' | 'idle';

export interface LiveSessions {
  workspace: string;
  /** The tools running, one each, in the order they started (claude, shell...). */
  targets: string[];
  state: LiveState;
  /** When the last of them stops, if no window shows any of them. */
  stopsAt?: string;
}

const at = (timestamp: string | undefined) => {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(time) ? time : undefined;
};

const printedRecently = (terminal: RunningTerminal, now: number) => {
  const output = at(terminal.lastOutputAt);
  return output !== undefined && now - output <= WORKING_WINDOW_MS;
};

/** Whether a CLI running in the workspace printed something a moment ago: the rule the working dot follows. */
export function workingIn(terminals: readonly RunningTerminal[] | undefined, workspace: string, now: number): boolean {
  return (terminals ?? []).some((terminal) => terminal.workspace === workspace && terminal.state === 'running' && printedRecently(terminal, now));
}

export function liveSessions(terminals: readonly RunningTerminal[], waiting: ReadonlySet<string>, now: number): Map<string, LiveSessions> {
  const groups = new Map<string, RunningTerminal[]>();
  for (const terminal of terminals) {
    if (terminal.state !== 'running') continue;
    groups.set(terminal.workspace, [...(groups.get(terminal.workspace) ?? []), terminal]);
  }
  const out = new Map<string, LiveSessions>();
  for (const [workspace, group] of groups) {
    const ordered = [...group].sort((a, b) => (at(a.startedAt) ?? 0) - (at(b.startedAt) ?? 0));
    const targets = [...new Set(ordered.map((terminal) => terminal.target))];
    const shown = group.some((terminal) => terminal.attached);
    const stops = group.map((terminal) => at(terminal.stopsAt)).filter((time): time is number => time !== undefined);
    const working = group.some((terminal) => printedRecently(terminal, now));
    const state: LiveState = waiting.has(workspace) ? 'waiting' : !shown ? 'closing' : working ? 'working' : 'idle';
    out.set(workspace, {
      workspace, targets, state,
      stopsAt: !shown && stops.length > 0 ? new Date(Math.max(...stops)).toISOString() : undefined,
    });
  }
  return out;
}

const names = (targets: readonly string[]) => {
  const all = targets.map((target) => harnessName(target));
  return all.length <= 1 ? (all[0] ?? 'A terminal') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
};

/** One sentence for a tooltip and for screen readers. */
export function liveText(live: LiveSessions, now: number): string {
  const who = names(live.targets);
  const plural = live.targets.length > 1;
  switch (live.state) {
    case 'waiting': return `${who} ${plural ? 'are' : 'is'} running and waiting for you`;
    case 'working': return `${who} ${plural ? 'are' : 'is'} running and working`;
    case 'idle': return `${who} ${plural ? 'are' : 'is'} running and idle`;
    case 'closing': {
      const stops = at(live.stopsAt);
      if (stops === undefined) return `${who} ${plural ? 'are' : 'is'} running with no chat open`;
      const minutes = Math.ceil((stops - now) / 60_000);
      return `${who} ${plural ? 'are' : 'is'} running with no chat open, and ${minutes <= 1 ? 'stops within a minute' : `stops in ${minutes} minutes`}`;
    }
  }
}

/** Workspaces with a running CLI first, keeping the chosen order inside each group. */
export function runningFirst<T extends { branchName: string }>(workspaces: readonly T[], live: ReadonlyMap<string, LiveSessions>): T[] {
  return [...workspaces.filter((workspace) => live.has(workspace.branchName)), ...workspaces.filter((workspace) => !live.has(workspace.branchName))];
}
