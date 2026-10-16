/**
 * @module utils/detect-editors
 * Detects which code editors are available on the system.
 */

import { probeCommand } from './probe.js';

import type { DetectedEditor } from '../types.js';

/** Editor definitions we probe for. */
const EDITOR_CANDIDATES: ReadonlyArray<{ name: string; command: string; platforms?: NodeJS.Platform[] }> = [
  { name: 'VS Code', command: 'code' },
  { name: 'VS Code Insiders', command: 'code-insiders' },
  { name: 'Cursor', command: 'cursor' },
  { name: 'Antigravity', command: 'antigravity' },
  { name: 'PowerShell', command: 'powershell', platforms: ['win32'] },
  { name: 'Command Prompt', command: 'cmd', platforms: ['win32'] },
  { name: 'IntelliJ IDEA', command: 'idea' },
  { name: 'WebStorm', command: 'webstorm' },
  { name: 'PyCharm', command: 'charm' },
  { name: 'Sublime Text', command: 'subl' },
  { name: 'Zed', command: 'zed' },
  { name: 'Windsurf', command: 'windsurf' },
];

/**
 * Attempts to probe whether the editor or shell command exists on the system.
 */
async function commandExists(command: string): Promise<boolean> {
  if (process.platform === 'win32') {
    if (command === 'powershell' || command === 'cmd') {
      return true;
    }
  }
  const outcome = await probeCommand(command, ['--version'], {
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  // A command that starts but does not answer in time is installed; it just
  // could not report a version (for example a snap on its first run).
  return outcome !== 'failed';
}

/**
 * Probes the system for known code editors and shells by checking whether their CLI
 * commands are available on PATH.
 *
 * @returns An array of {@link DetectedEditor} results, one per editor.
 */
// Editor detection starts one process per candidate (an editor's --version is
// often a whole Electron start), and the GUI asks for it from two endpoints at
// startup and again whenever a workspace opens. Share one run and reuse it for
// 10 minutes; the GUI caches the answer for as long, so a newly installed
// editor appears within 10 minutes, or at once after a restart.
export const DETECTION_TTL_MS = 10 * 60_000;
let cachedDetection: { at: number; result: Promise<DetectedEditor[]> } | null = null;

/** Forgets the shared detection result (for tests). */
export function clearEditorDetectionCache(): void {
  cachedDetection = null;
}

export function detectEditors(): Promise<DetectedEditor[]> {
  if (cachedDetection && Date.now() - cachedDetection.at < DETECTION_TTL_MS) return cachedDetection.result;
  const result = probeEditors();
  cachedDetection = { at: Date.now(), result };
  result.catch(() => {
    if (cachedDetection?.result === result) cachedDetection = null;
  });
  return result;
}

async function probeEditors(): Promise<DetectedEditor[]> {
  const currentPlatform = process.platform;
  const candidates = EDITOR_CANDIDATES.filter(
    (c) => !c.platforms || c.platforms.includes(currentPlatform)
  );

  const probes = candidates.map(async (editor) => {
    const detected = await commandExists(editor.command);
    return {
      name: editor.name,
      command: editor.command,
      detected,
    } satisfies DetectedEditor;
  });

  return Promise.all(probes);
}
