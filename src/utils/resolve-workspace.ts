/**
 * @module utils/resolve-workspace
 * Shared workspace-path resolution used by commands. Replaces the near-identical
 * private `resolveWorkspace` helpers previously copied across commit/diff/finish
 * and other commands.
 */

import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { loadConfig } from '../core/config.js';
import { findWorkspaceRoot, listWorkspaces, loadFeatureConfig } from '../core/workspace.js';

import { PRIMARY_MANIFEST_FILE, LEGACY_MANIFEST_FILE } from '../core/constants.js';

/** An implicit write must agree with the nearest manifest on disk, even in a copy nested inside the original. */
export async function assertWorkspaceWriteLocation(workspacePath: string, cwd = process.cwd()): Promise<void> {
  const real = (dir: string) => fs.realpath(dir).catch(() => path.resolve(dir));
  const [here, workspace] = await Promise.all([real(cwd), real(workspacePath)]);
  const localRoot = await findWorkspaceRoot(here);
  if (localRoot ? path.relative(workspace, localRoot) === '' : isInside(workspace, here)) return;
  throw new Error(`You are in ${localRoot ?? here}, but the workspace found from here is ${workspace} (this folder may be a copy). Nothing was changed. Say which workspace to act on with --workspace <path>.`);
}

function isInside(root: string, dir: string): boolean {
  const relative = path.relative(root, dir);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolves a workspace path without any interactive prompts.
 *
 * Resolution order: explicit argument → workspace detected from the current
 * working directory → `null`.
 *
 * @param workspaceArg - Optional explicit workspace path.
 * @returns Absolute workspace path, or `null` when none can be determined.
 * @throws If an explicit `workspaceArg` is given but has no manifest.
 */
export async function resolveWorkspaceQuiet(workspaceArg?: string): Promise<string | null> {
  if (workspaceArg) {
    const config = await loadConfig();
    const candidatePaths = [
      path.resolve(workspaceArg),
      ...(config.workspacesDir ? [path.join(config.workspacesDir, workspaceArg)] : []),
    ];

    for (const absolutePath of candidatePaths) {
      try {
        await fs.access(path.join(absolutePath, PRIMARY_MANIFEST_FILE));
        return absolutePath;
      } catch {
        try {
          await fs.access(path.join(absolutePath, LEGACY_MANIFEST_FILE));
          return absolutePath;
        } catch {
          // Continue to next candidate
        }
      }
    }
    throw new Error(`Invalid workspace: No ${PRIMARY_MANIFEST_FILE} found at ${workspaceArg}`);
  }

  const cwdFeature = await loadFeatureConfig(process.cwd());
  if (cwdFeature) {
    return cwdFeature.workspacePath;
  }

  return null;
}

/**
 * Resolves a workspace path, falling back to an interactive picker when it
 * cannot be determined from the argument or the current directory.
 *
 * Prints friendly errors (and returns `null`) rather than throwing, so callers
 * can simply `return` when the result is `null`.
 *
 * @param workspaceArg - Optional explicit workspace path.
 * @param promptMessage - Prompt shown when picking from the workspace list.
 * @returns Absolute workspace path, or `null` when unavailable/none selected.
 */
export async function resolveWorkspaceInteractive(
  workspaceArg: string | undefined,
  promptMessage: string,
  options: { archived?: 'exclude' | 'include' | 'only' } = {},
): Promise<string | null> {
  try {
    const quiet = await resolveWorkspaceQuiet(workspaceArg);
    if (quiet) {
      return quiet;
    }
  } catch (error) {
    console.error(chalk.red(`✖ ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }

  const config = await loadConfig();
  // Archived workspaces are records, not places to work: pickers leave them
  // out unless the command acts on archived workspaces.
  const archived = options.archived ?? 'exclude';
  const workspaces = (await listWorkspaces(config.workspacesDir)).filter((ws) =>
    archived === 'include' ? true : archived === 'only' ? Boolean(ws.archivedAt) : !ws.archivedAt,
  );

  if (workspaces.length === 0) {
    console.log(chalk.yellow(archived === 'only' ? 'No archived workspaces found.\n' : 'No workspaces found.\n'));
    return null;
  }

  const selected = await select({
    message: promptMessage,
    choices: workspaces.map((ws) => ({
      name: `${ws.branchName} ${chalk.dim(`(${ws.repos.length} repos${ws.archivedAt ? ', archived' : ''})`)}`,
      value: ws.workspacePath,
    })),
  });

  return selected;
}
