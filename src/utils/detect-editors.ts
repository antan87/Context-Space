/**
 * @module utils/detect-editors
 * Detects which code editors are available on the system.
 */

import { findExecutable } from './user-paths.js';

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
// An editor is installed when its command is on PATH. Asking each one for its --version instead started about ten
// processes per detection, several of them whole Electron apps; a launcher that is present but broken reports its own
// error when it is used.
async function commandExists(command: string): Promise<boolean> {
  if (process.platform === 'win32' && (command === 'powershell' || command === 'cmd')) return true;
  return findExecutable(command) !== null;
}

/**
 * Probes the system for known code editors and shells by checking whether their CLI
 * commands are available on PATH.
 *
 * @returns An array of {@link DetectedEditor} results, one per editor.
 */
// The GUI asks for detection from two endpoints at startup and whenever a
// workspace opens. Share one run and reuse it briefly; the GUI caches the answer
// for the same 60 s, so a newly installed editor still appears within a minute.
export const DETECTION_TTL_MS = 60_000;
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
