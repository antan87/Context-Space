/**
 * @module agent/nativeTools
 * Shared prompt, tool metadata, and execution for the SDK-backed native agents
 * (OpenAI / Anthropic / Gemini). Keeping the tool executor here means the
 * read-only workspace access — and its path-containment guard — is defined
 * once instead of copied into three agent loops.
 */

import fs from 'fs-extra';
import path from 'node:path';

export const NATIVE_STEP_LIMIT = 5;
export const STEP_LIMIT_NOTICE =
  '\n\n*Stopped after reaching the tool-step limit without a final answer. Send a follow-up message to continue.*\n';

export function buildSystemPrompt(cwd: string): string {
  return `You are an expert coding assistant running within the NexusFlow IDE.
You have read-only access to the user's workspace at ${cwd} through your tools: you can read files and list directories, but you cannot edit files or run commands.
When relevant to your task, consult procedural skill playbooks in .agents/skills/ using read_file.
When suggesting code changes, include the proposed diff directly in your text response so the user can apply it themselves.`;
}

export interface NativeToolMeta {
  name: string;
  description: string;
  argName: string;
  argDescription: string;
}

/** Provider-agnostic description of the two read-only tools. Each agent maps
 *  these into its own SDK's schema shape. */
export const NATIVE_TOOLS: NativeToolMeta[] = [
  { name: 'read_file', description: 'Read the contents of a file', argName: 'filePath', argDescription: 'Path to file relative to workspace' },
  { name: 'list_directory', description: 'List the contents of a directory', argName: 'dirPath', argDescription: 'Path to directory relative to workspace' },
];

function assertWithin(base: string, target: string, rel: unknown): void {
  // Trailing separator stops a sibling like `workspace-secret` from passing
  // the prefix test for base `workspace`.
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the workspace: ${String(rel)}`);
  }
}

/**
 * Resolve a workspace-relative path and refuse anything that escapes `cwd`,
 * including via symlinks. The lexical check catches `..`/absolute paths; the
 * realpath check catches a symlink inside the workspace that points outside.
 */
async function resolveWithin(cwd: string, rel: unknown): Promise<string> {
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, typeof rel === 'string' ? rel : '');
  assertWithin(base, resolved, rel);

  // Follow symlinks and re-check. realpath throws ENOENT for a missing target,
  // which the fs read below would raise anyway — let it surface as-is.
  const realBase = await fs.realpath(base);
  const realTarget = await fs.realpath(resolved);
  assertWithin(realBase, realTarget, rel);
  return realTarget;
}

/**
 * Execute a native tool call. Returns the tool's textual result; throws on an
 * unknown tool, a path-containment violation, or a filesystem error (callers
 * surface the message back to the model).
 */
export async function executeNativeTool(cwd: string, name: string, args: unknown): Promise<string> {
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  if (name === 'read_file') {
    const abs = await resolveWithin(cwd, record.filePath);
    return await fs.readFile(abs, 'utf8');
  }
  if (name === 'list_directory') {
    const abs = await resolveWithin(cwd, record.dirPath);
    return (await fs.readdir(abs)).join('\n');
  }
  throw new Error(`Unknown tool: ${name}`);
}
