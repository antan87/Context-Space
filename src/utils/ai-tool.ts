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

/** How an AI tool runs the workspace CLI: from PATH, or the workspace's own copy. */
const CLI_LAUNCHERS = ['ctxspace', './.contextspace/bin/ctxspace', '.contextspace/bin/ctxspace'];

/**
 * What an AI tool may run without asking each time: the plan, asking the user a question, and searching the knowledge.
 * They change nothing but the plan and the chat's alerts, or read. Every other command stays behind the usual
 * approval, `ctxspace knowledge add`, `promote` and `remote` among them, since those write and push.
 */
const ALLOWED_COMMANDS: readonly (readonly string[])[] = [['plan'], ['ask'], ['knowledge', 'search']];

/**
 * Only the commands in {@link ALLOWED_COMMANDS}, so an AI tool may run them without asking each time. Several may
 * be joined with `&&` or `||` (AIs like a fallback to the workspace copy), and `2>&1` is allowed.
 * Every word must be plain, or quoted with nothing the shell expands: no other command, pipe,
 * redirection, variable, substitution, subshell or glob. Anything else still needs the usual approval.
 */
export function isPlainAiCommand(command: string): boolean {
  const commands: string[][] = [[]];
  let rest = command.trim();
  while (rest) {
    const token = /^(?:&&|\|\||2>&1)(?=[ \t]|$)|^(?:[A-Za-z0-9_./:=@,+%-]+|'[^']*'|"[^"$`\\!]*")+/.exec(rest);
    if (!token) return false;
    if (token[0] === '&&' || token[0] === '||') commands.push([]);
    else if (token[0] !== '2>&1') commands.at(-1)!.push(token[0]);
    rest = rest.slice(token[0].length);
    const space = /^[ \t]+/.exec(rest);
    if (space) rest = rest.slice(space[0].length);
    else if (rest) return false;
  }
  return commands.every((words) =>
    CLI_LAUNCHERS.includes(words[0] ?? '') && ALLOWED_COMMANDS.some((allowed) => allowed.every((word, index) => words[index + 1] === word)));
}
