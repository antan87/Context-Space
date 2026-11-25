/**
 * @module generators/antigravity
 * Generates an AGENTS.md file for Antigravity.
 */

import path from 'node:path';
import fse from 'fs-extra';
import type { WorkspaceContext } from '../types.js';
import { buildContextContent } from './base.js';
import { GENERATED_SNAPSHOT_HEADER } from '../core/generation-lock.js';

/**
 * Generates an `AGENTS.md` file at the workspace root.
 *
 * Antigravity reads this file for persistent context about the workspace.
 *
 * @param ctx           - The workspace context (feature + repos + analysis).
 * @param workspacePath - Absolute path to the workspace root directory.
 */
export async function generateAntigravityConfig(
  ctx: WorkspaceContext,
  workspacePath: string,
): Promise<void> {
  const content = `${GENERATED_SNAPSHOT_HEADER}\n\n${await buildContextContent(ctx, workspacePath)}`;
  const filePath = path.join(workspacePath, 'AGENTS.md');

  try {
    await fse.writeFile(filePath, content, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write AGENTS.md: ${message}`);
  }
}
