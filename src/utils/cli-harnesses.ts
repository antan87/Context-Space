/** CLI capabilities shared by terminal launch and saved-session discovery.
 * A new history-capable harness must register a complete reader in session-readers.
 * The GUI receives history sources from the API, so it needs no source list.
 */
export const CLI_HARNESSES = {
  antigravity: { name: 'Antigravity (agy)', binary: 'agy', resumeArgs: (id: string) => ['--conversation', id], continueArgs: ['--continue'], promptArgs: (text: string) => ['--prompt-interactive', text], history: true },
  claude: { name: 'Claude Code', binary: 'claude', resumeArgs: (id: string) => ['--resume', id], continueArgs: ['--resume'], promptArgs: (text: string) => [text], history: true },
  codex: { name: 'Codex', binary: 'codex', resumeArgs: (id: string) => ['resume', id], continueArgs: ['resume'], promptArgs: (text: string) => [text], history: true },
  copilot: { name: 'GitHub Copilot', binary: 'copilot', resumeArgs: (id: string) => ['--resume', id], continueArgs: ['--resume'], history: true },
  cursor: { name: 'Cursor Agent', binary: 'cursor-agent', terminalBinaries: ['agent', 'cursor-agent'], resumeArgs: (id: string) => ['--resume', id], continueArgs: [], history: false },
  pi: { name: 'Pi', binary: 'pi', resumeArgs: (id: string) => ['--session', id], continueArgs: ['--continue'], promptArgs: (text: string) => ['--', text], history: true },
} as const;

export type CliHarnessId = keyof typeof CLI_HARNESSES;

/** How a tool starts an interactive session with a first message, or null when it cannot. */
export function harnessPromptArgs(id: CliHarnessId, text: string): string[] | null {
  const harness = CLI_HARNESSES[id];
  return 'promptArgs' in harness ? harness.promptArgs(text) : null;
}
export type SessionSource = { [K in CliHarnessId]: typeof CLI_HARNESSES[K]['history'] extends true ? K : never }[CliHarnessId] | 'workspace';
export const SESSION_SOURCES: SessionSource[] = [
  ...(Object.keys(CLI_HARNESSES) as CliHarnessId[]).filter((id): id is Exclude<SessionSource, 'workspace'> => CLI_HARNESSES[id].history),
  'workspace',
];

export function isCliHarnessId(id: string): id is CliHarnessId {
  return Object.hasOwn(CLI_HARNESSES, id);
}
