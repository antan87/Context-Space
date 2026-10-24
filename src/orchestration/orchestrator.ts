/**
 * @module orchestration/orchestrator
 * Executes detected orchestration tools (docker-compose, Aspire, Tilt,
 * Procfile, Makefile). Only the structured `run`/`stopRun` invocations from
 * detection are ever executed — never display strings, never client input.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';

import type { OrchestrationDetection, RunningOrchestrator } from '../types.js';
import { getPm2List, mutateRunningState, pm2Prefix, pm2Start, readRawRunningState, serviceLogFile } from './runner.js';

/**
 * Slugifies a detection id into a PM2/filesystem-safe token. Keyed on the id
 * (`<tool>:<relative config path>`), NOT the tool alone, so two same-tool
 * detections in different sub-repos (e.g. a Makefile in each) get distinct PM2
 * apps and log files instead of colliding onto one — where starting the second
 * would `pm2 delete` the first and both would stream into a shared log.
 */
function orchSlug(detection: OrchestrationDetection): string {
  return detection.id
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** PM2 app name for a pm2-mode orchestrator: `nexusflow-<ws>-orch-<slug>`. */
export function orchestratorPm2Name(workspacePath: string, detection: OrchestrationDetection): string {
  return `${pm2Prefix(workspacePath)}orch-${orchSlug(detection)}`;
}

/** Log source name for a pm2-mode orchestrator (tailable like a service). */
export function orchestratorLogName(detection: OrchestrationDetection): string {
  return `orch-${orchSlug(detection)}`;
}

/**
 * Starts a detected orchestration tool.
 * - `oneshot` (docker compose): awaits `run` — the command detaches by itself.
 * - `pm2`: wraps `run` in a PM2 app whose log streams like a service log.
 * Records the orchestrator in the running state. Throws with the tool's
 * stderr on failure.
 */
export async function startOrchestrator(
  detection: OrchestrationDetection,
  workspacePath: string,
  logDir: string,
): Promise<RunningOrchestrator> {
  const running: RunningOrchestrator = {
    id: detection.id,
    tool: detection.tool,
    configPath: detection.configPath,
    mode: detection.mode,
    startedAt: new Date().toISOString(),
  };

  if (detection.mode === 'oneshot') {
    await execa(detection.run.command, detection.run.args, {
      cwd: detection.run.cwd,
      shell: false,
    });
  } else {
    const pm2Name = orchestratorPm2Name(workspacePath, detection);
    const logName = orchestratorLogName(detection);
    const logFile = serviceLogFile(logDir, logName);
    await fs.mkdir(path.dirname(logFile), { recursive: true });

    // Same launch shape as service starts, so the log is tailable by the shared
    // SSE endpoint and the app shows up under the workspace prefix.
    await pm2Start({
      name: pm2Name,
      command: detection.run.command,
      args: detection.run.args,
      cwd: detection.run.cwd,
      logFile,
    });
    running.pm2Name = pm2Name;
    running.logName = logName;
  }

  await mutateRunningState(workspacePath, (state) => ({
    ...state,
    orchestrators: [...(state.orchestrators ?? []).filter((o) => o.id !== detection.id), running],
  }));
  return running;
}

/**
 * Stops a detected orchestration tool: runs `stopRun` when the tool has one
 * (compose `down`, tilt `down`), deletes the PM2 app for pm2-mode tools, and
 * removes the entry from the running state.
 */
export async function stopOrchestrator(
  detection: OrchestrationDetection,
  workspacePath: string,
): Promise<void> {
  if (detection.mode === 'pm2') {
    const pm2Name = orchestratorPm2Name(workspacePath, detection);
    const pm2List = await getPm2List();
    if (pm2List.some((app) => app.name === pm2Name)) {
      await execa('npx', ['pm2', 'delete', pm2Name], { reject: false });
    }
  }

  if (detection.stopRun) {
    // Best-effort: compose down / tilt down may fail if nothing is up.
    await execa(detection.stopRun.command, detection.stopRun.args, {
      cwd: detection.stopRun.cwd,
      shell: false,
      reject: false,
    });
  }

  await mutateRunningState(workspacePath, (state) => ({
    ...state,
    orchestrators: (state.orchestrators ?? []).filter((o) => o.id !== detection.id),
  }));
}

/**
 * Stops an orchestrator recorded in the running state that is no longer
 * detected, such as a Procfile started through honcho before Procfiles became
 * declared services. Its PM2 app is deleted by the recorded name. Returns
 * whether such an entry existed.
 */
export async function stopRecordedOrchestrator(id: string, workspacePath: string): Promise<boolean> {
  const state = await readRawRunningState(workspacePath);
  const recorded = state?.orchestrators?.find((o) => o.id === id);
  if (!recorded) return false;
  if (recorded.mode === 'pm2' && recorded.pm2Name) {
    await execa('npx', ['pm2', 'delete', recorded.pm2Name], { reject: false });
  }
  await mutateRunningState(workspacePath, (current) => ({
    ...current,
    orchestrators: (current.orchestrators ?? []).filter((o) => o.id !== id),
  }));
  return true;
}
