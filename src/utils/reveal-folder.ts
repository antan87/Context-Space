/**
 * @module utils/reveal-folder
 * Opens a skill's folder in the system file manager. Callers pass a folder the catalog already
 * knows about (see the reveal route), never a path typed by the user.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

/** The command that opens a folder in this platform's file manager. */
export function fileManagerCommand(platform: NodeJS.Platform, folder: string): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: [folder] };
  if (platform === 'darwin') return { command: 'open', args: [folder] };
  return { command: 'xdg-open', args: [folder] };
}

/** Opens the folder without waiting for the file manager. Throws when the folder is not a directory. */
export async function revealFolder(folder: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('The skill folder no longer exists.');
  const { command, args } = fileManagerCommand(platform, folder);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', reject);
    // The file manager may outlive this call, so it is not waited for: resolve as soon as it started.
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
