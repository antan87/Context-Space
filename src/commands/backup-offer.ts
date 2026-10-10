/**
 * @module commands/backup-offer
 * At workspace creation, offer to attach a git remote so the notes a person will write here
 * (knowledge, planning) survive losing this computer. Entirely the user's choice: it adds a
 * remote only when they paste a URL, and it never pushes.
 */

import chalk from 'chalk';
import { input } from '@inquirer/prompts';

import { addWorkspaceRemote } from '../core/workspace-git.js';
import { CLI_NAME } from '../core/constants.js';

export interface BackupOfferOptions {
  /** Skip the offer (for example the quick-fix flow, which is meant to be fast). */
  skip?: boolean;
  /** Whether a person is at the keyboard. Defaults to whether stdin is a terminal. */
  interactive?: boolean;
  /** Asks the question and returns the answer. Defaults to an interactive prompt. */
  ask?: (message: string) => Promise<string>;
}

export async function offerBackupRemote(workspacePath: string, options: BackupOfferOptions = {}): Promise<'added' | 'declined' | 'skipped' | 'failed'> {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  if (options.skip || !interactive) return 'skipped';

  const ask = options.ask ?? ((message: string) => input({ message, default: '' }));
  let url: string;
  try {
    url = (await ask("Back this workspace's notes up to a git remote? Paste its URL, or press Enter to skip:")).trim();
  } catch {
    // A cancelled prompt (Ctrl+C) is a "no", not a failed workspace.
    return 'declined';
  }

  if (!url) {
    console.log(chalk.dim(`  You can add one later with "${CLI_NAME} remote add <git-url>".`));
    return 'declined';
  }
  try {
    await addWorkspaceRemote(workspacePath, url);
    console.log(chalk.green('  ✔ Added the git remote "origin" for this workspace\'s notes.'));
    console.log(chalk.dim(`    Nothing was pushed. Run "${CLI_NAME} remote push" once you have something to keep.`));
    return 'added';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`  ⚠ Could not add the remote (${message}). Try "${CLI_NAME} remote add <git-url>" later.`));
    return 'failed';
  }
}
