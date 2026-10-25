/**
 * @module utils/detect-ai
 * Detects which AI coding assistants are available on the system.
 */

import { probeCommand } from './probe.js';
import { HARNESSES, HARNESS_IDS, type HarnessDefinition } from '../harnesses/registry.js';

import type { DetectedAI } from '../types.js';

/**
 * Attempts to run `<command> --version` and returns `true` if the process
 * exits successfully (exit code 0).
 */
async function commandExists(command: string): Promise<boolean> {
  // A CLI that starts but does not answer in time is installed.
  return (await probeCommand(command, ['--version'], { shell: process.platform === 'win32' })) !== 'failed';
}

/**
 * Probes the system for every harness in the registry and returns their status, in registry order.
 *
 * `detected` reports whether the assistant should be offered as an option;
 * `command` is set only when a CLI that can host an *interactive terminal
 * session* is available (it is the single source of truth for launching one).
 * Some assistants can be detected without being launchable this way — Cursor's
 * `cursor` binary opens the GUI editor rather than a terminal agent (its
 * launchable CLI is `cursor-agent`).
 *
 * Detection rules, from each registry entry:
 * - Detected when its `detectBinary` (default: its `binary`) is on PATH.
 * - Launchable, and `command` set, when its `binary` is on PATH.
 *   Cursor is the one that differs: `cursor` detects it, `cursor-agent` launches it.
 *
 * @returns An array of {@link DetectedAI} results, one per assistant.
 */
export async function detectAIAssistants(): Promise<DetectedAI[]> {
  // Run all probes concurrently.
  return Promise.all(HARNESS_IDS.map(async (name) => {
    const harness: HarnessDefinition = HARNESSES[name];
    const detectBinary = harness.detectBinary ?? harness.binary;
    const [detected, launchable] = await Promise.all([
      commandExists(detectBinary),
      detectBinary === harness.binary ? undefined : commandExists(harness.binary),
    ]);
    const canLaunch = launchable ?? detected;
    return {
      name,
      displayName: harness.setupName,
      detected,
      ...(canLaunch ? { command: harness.binary } : {}),
    };
  }));
}
