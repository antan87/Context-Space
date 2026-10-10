/**
 * @module utils/ai-tool
 * Whether a command runs inside an AI tool. Some AI tools (Antigravity among them) run commands in a
 * terminal, so a terminal alone does not mean a person is typing; these variables tell them apart.
 */

/** Variables AI tools set for the commands they run. ContextSpace sets CTXSPACE_HARNESS itself. */
const AI_TOOL_ENV = ['CTXSPACE_HARNESS', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'GEMINI_CLI'];
const AI_TOOL_ENV_PREFIXES = ['ANTIGRAVITY', 'AGY_'];

export function runsInsideAiTool(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some((key) => env[key] && (AI_TOOL_ENV.includes(key) || AI_TOOL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))));
}

/** Environment overrides that make a child process look like a person's terminal, for tests. */
export function asPersonEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = new Set([...AI_TOOL_ENV, ...Object.keys(env).filter((key) => AI_TOOL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))]);
  return Object.fromEntries([...keys].map((key) => [key, '']));
}
