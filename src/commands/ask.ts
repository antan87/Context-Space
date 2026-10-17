/**
 * @module commands/ask
 * `ctxspace ask "<question>"` — an AI tells the user it is blocked and needs their answer. It does what the MCP tool
 * `request_user_input` does (the app shows an alert that the AI is waiting), for the AI tools that cannot use MCP.
 */

import { askUser } from '../core/ask-user.js';
import { resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';

export interface AskOptions {
  /** Short answers the user can pick; repeat the flag for more. */
  option?: string[];
  /** The AI tool asking, for the alert. */
  harness?: string;
  workspace?: string;
}

/**
 * The AI tool asking: `--harness`, else CTXSPACE_HARNESS, else Claude Code when it set CLAUDECODE, else just "agent".
 * The order `ctxspace plan` names its changes by; a blank name counts as none, so it cannot hide the next one.
 */
export function askHarness(options: { harness?: string }, env: NodeJS.ProcessEnv): string {
  const names = [options.harness, env.CTXSPACE_HARNESS, env.CLAUDECODE ? 'claude' : undefined];
  return names.map((name) => name?.trim().toLowerCase()).find(Boolean) || 'agent';
}

/**
 * `ask` — alerts the user and tells the AI to wait for the answer in the chat.
 *
 * @throws When there is no workspace here, or the question is empty or too long.
 */
export async function askCommand(question: string, options: AskOptions): Promise<void> {
  const workspacePath = await resolveWorkspaceQuiet(options.workspace);
  if (!workspacePath) throw new Error('No workspace here. Run this inside a workspace folder, or pass --workspace <path>.');

  const result = await askUser(workspacePath, {
    message: question,
    options: options.option,
    harness: askHarness(options, process.env),
  });
  console.log(result.message);
}
