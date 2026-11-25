/**
 * @module generators/codex
 * Generates an AGENTS.md file for OpenAI Codex.
 * Uses the shared base content and adds Codex-specific sections.
 */

import path from 'node:path';
import fse from 'fs-extra';
import type { WorkspaceContext } from '../types.js';
import { buildContextContent } from './base.js';
import { GENERATED_SNAPSHOT_HEADER } from '../core/generation-lock.js';

/**
 * Generates an `AGENTS.md` file at the workspace root.
 *
 * Codex reads AGENTS.md for persistent context about the workspace.
 *
 * @param ctx           - The workspace context (feature + repos + analysis).
 * @param workspacePath - Absolute path to the workspace root directory.
 */
export async function generateCodexConfig(
  ctx: WorkspaceContext,
  workspacePath: string,
): Promise<void> {
  const baseContent = await buildContextContent(ctx, workspacePath);

  const codexExtra = `
---

## Codex-Specific Notes

- Each project subdirectory may contain its own \`AGENTS.md\` or
  \`AGENTS.override.md\` with module-specific context.
- When working in a subdirectory, check for local overrides before
  applying workspace-level guidance.
- Use \`codex --approval-mode suggest\` for cross-repo changes to
  review each change before applying.
`;

  const content = `${GENERATED_SNAPSHOT_HEADER}\n\n${baseContent}${codexExtra}`;
  const filePath = path.join(workspacePath, 'AGENTS.md');

  try {
    await fse.writeFile(filePath, content, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write AGENTS.md: ${message}`);
  }
}
