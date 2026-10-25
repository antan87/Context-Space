/**
 * @module harnesses/registry
 * Everything the app knows about an AI harness (Claude Code, Codex, Pi, ...), in one entry each.
 * The assistant ids, terminal targets, detection, skill folders and instruction files all derive from `HARNESSES`.
 *
 * To add a harness: add one entry below. A missing field is a compile error.
 * See docs/adding-a-harness.md for what each field means and the optional extras.
 *
 * Registry order is display order, and precedence when two harnesses ship a skill with the same id.
 */

import { PRIMARY_CURSOR_RULE_FILE } from '../core/constants.js';

/**
 * The folders inside a workspace that a harness can read skills from.
 * A new folder also needs an entry in `SKILL_FOLDER_ADAPTERS` and a lock adapter in resources/contracts.ts.
 */
export type WorkspaceSkillFolder = '.agents/skills' | '.claude/skills';

export interface HarnessDefinition {
  /** Name shown wherever the tool is named: "Built into Claude Code", terminal messages. */
  name: string;
  /** Name offered when choosing the assistants of a workspace. */
  setupName: string;
  /** The program that starts an interactive session. It is also probed on PATH to see whether the tool is installed. */
  binary: string;
  /** Probed instead of `binary` to offer the tool: Cursor is offered when its editor is installed, but launched through `cursor-agent`. */
  detectBinary?: string;
  /** Names the embedded terminal looks for, in order, when `binary` is not the only one. */
  terminalBinaries?: readonly string[];
  resumeArgs: (id: string) => string[];
  /** Arguments that continue the latest session. */
  continueArgs: readonly string[];
  /** Arguments that start an interactive session with a first message. Absent when the tool cannot. */
  promptArgs?: (text: string) => string[];
  /** Whether saved sessions can be listed. True needs a reader in utils/session-readers.ts or session-finder.ts. */
  history: boolean;
  skills: {
    /** The folder inside a workspace this tool reads skills from. */
    workspaceFolder: WorkspaceSkillFolder;
    /**
     * Folders the tool loads skills from in every workspace. A leading `~/` is the home directory.
     * Skills there are shown as "Built into <name>" and are never copied. `[]` when none is known.
     */
    globalRoots: readonly string[];
    /** How many folder levels below a root to search for `SKILL.md` (default 3). */
    maxDepth?: number;
  };
  /** The file this tool needs for its own instructions, or null when it reads AGENTS.md. */
  instructions: { outputFile: string } | null;
  /** Whether core/agent-mcp.ts registers the ContextSpace MCP server with this tool at user level. */
  mcp: boolean;
  /** Whether workspaces created without an explicit choice (the MCP create tool) include this tool. */
  defaultForNewWorkspaces: boolean;
}

export const HARNESSES = {
  claude: {
    name: 'Claude Code',
    setupName: 'Claude Code',
    binary: 'claude',
    resumeArgs: (id: string) => ['--resume', id],
    continueArgs: ['--resume'],
    promptArgs: (text: string) => [text],
    history: true,
    skills: {
      workspaceFolder: '.claude/skills',
      // skills/<skill>, plus claude.ai-synced skills at skills/synced/<bucket>/<skill>.
      // Plugin skills under ~/.claude/plugins use a layout that varies per marketplace and are not covered yet.
      globalRoots: ['~/.claude/skills'],
    },
    instructions: { outputFile: 'CLAUDE.md' },
    mcp: true,
    defaultForNewWorkspaces: true,
  },
  antigravity: {
    name: 'Antigravity (agy)',
    setupName: 'Antigravity',
    binary: 'agy',
    resumeArgs: (id: string) => ['--conversation', id],
    continueArgs: ['--continue'],
    promptArgs: (text: string) => ['--prompt-interactive', text],
    history: true,
    skills: {
      workspaceFolder: '.agents/skills',
      // builtin/skills/<skill>, config/skills/<skill>, and config/plugins/<plugin>/skills/<skill>.
      globalRoots: [
        '~/.gemini/antigravity/builtin/skills',
        '~/.gemini/antigravity-cli/builtin/skills',
        '~/.gemini/config/skills',
        '~/.gemini/config/plugins',
      ],
    },
    instructions: null,
    mcp: true,
    defaultForNewWorkspaces: true,
  },
  codex: {
    name: 'Codex',
    setupName: 'OpenAI Codex',
    binary: 'codex',
    resumeArgs: (id: string) => ['resume', id],
    continueArgs: ['resume'],
    promptArgs: (text: string) => [text],
    history: true,
    skills: {
      workspaceFolder: '.agents/skills',
      // skills/.system/<skill> holds the skills bundled with Codex.
      globalRoots: ['~/.codex/skills'],
    },
    instructions: null,
    mcp: true,
    defaultForNewWorkspaces: true,
  },
  copilot: {
    name: 'GitHub Copilot',
    setupName: 'GitHub Copilot',
    binary: 'copilot',
    resumeArgs: (id: string) => ['--resume', id],
    continueArgs: ['--resume'],
    history: true,
    // No global skills folder is known.
    skills: { workspaceFolder: '.agents/skills', globalRoots: [] },
    instructions: { outputFile: '.github/copilot-instructions.md' },
    mcp: false,
    defaultForNewWorkspaces: false,
  },
  cursor: {
    name: 'Cursor Agent',
    setupName: 'Cursor',
    binary: 'cursor-agent',
    // `cursor` opens the GUI editor; `cursor-agent` is the terminal session CLI.
    detectBinary: 'cursor',
    terminalBinaries: ['agent', 'cursor-agent'],
    resumeArgs: (id: string) => ['--resume', id],
    continueArgs: [],
    history: false,
    // No global skills folder is known.
    skills: { workspaceFolder: '.agents/skills', globalRoots: [] },
    instructions: { outputFile: PRIMARY_CURSOR_RULE_FILE },
    mcp: false,
    defaultForNewWorkspaces: false,
  },
  pi: {
    name: 'Pi',
    setupName: 'Pi',
    binary: 'pi',
    resumeArgs: (id: string) => ['--session', id],
    continueArgs: ['--continue'],
    promptArgs: (text: string) => ['--', text],
    history: true,
    skills: {
      workspaceFolder: '.agents/skills',
      // Pi reads the shared Agent Skills location in every workspace, next to its own folder.
      globalRoots: ['~/.pi/agent/skills', '~/.agents/skills'],
    },
    instructions: null,
    mcp: true,
    defaultForNewWorkspaces: false,
  },
} as const satisfies Record<string, HarnessDefinition>;

export type HarnessId = keyof typeof HARNESSES;
/** Every harness id, in registry order. Typed as a tuple so it can feed `z.enum`. */
export const HARNESS_IDS = Object.keys(HARNESSES) as [HarnessId, ...HarnessId[]];

type Registry = Readonly<Record<string, HarnessDefinition>>;

export function isHarnessId(id: string): id is HarnessId {
  return Object.hasOwn(HARNESSES, id);
}

/** How a tool starts an interactive session with a first message, or null when it cannot. */
export function harnessPromptArgs(id: HarnessId, text: string): string[] | null {
  const harness = HARNESSES[id];
  return 'promptArgs' in harness ? harness.promptArgs(text) : null;
}

export type SessionSource = { [K in HarnessId]: typeof HARNESSES[K]['history'] extends true ? K : never }[HarnessId] | 'workspace';
export const SESSION_SOURCES: SessionSource[] = [
  ...HARNESS_IDS.filter((id): id is Exclude<SessionSource, 'workspace'> => HARNESSES[id].history),
  'workspace',
];

/** Ids of the harnesses `core/agent-mcp.ts` registers the MCP server with (`mcp: true`). Each needs a target there. */
export type McpHarnessId = { [K in HarnessId]: typeof HARNESSES[K]['mcp'] extends true ? K : never }[HarnessId];

/** Ids of the harnesses whose own instruction file ContextSpace writes, which are the ones that need a generator. */
export type InstructionHarnessId = { [K in HarnessId]: typeof HARNESSES[K]['instructions'] extends null ? never : K }[HarnessId];

// Skills

/**
 * Lock adapter id of each skill folder. These ids are written to workspaces' resource locks,
 * so they never change. Adding a folder to `WorkspaceSkillFolder` fails here until it has one.
 */
export const SKILL_FOLDER_ADAPTERS = {
  '.agents/skills': 'agent-skill-v1',
  '.claude/skills': 'claude-skill-v1',
} as const satisfies Record<WorkspaceSkillFolder, string>;

/** The folder workspace-authored skills are saved in. A skill there is never copied back into it. */
export const LOCAL_SKILLS_FOLDER: WorkspaceSkillFolder = '.agents/skills';

/** The distinct workspace folders some harness reads skills from, sorted. Every skill is written to each. */
export function workspaceSkillFolders(harnesses: Registry = HARNESSES): WorkspaceSkillFolder[] {
  return [...new Set(Object.values(harnesses).map((harness) => harness.skills.workspaceFolder))].sort();
}

/** The skill folder a lock adapter id stands for, or undefined for an adapter that is not a current folder. */
export function skillFolderOfAdapter(adapter: string): WorkspaceSkillFolder | undefined {
  return (Object.keys(SKILL_FOLDER_ADAPTERS) as WorkspaceSkillFolder[]).find((folder) => SKILL_FOLDER_ADAPTERS[folder] === adapter);
}

/** Where each harness keeps the skills it loads in every workspace, keyed like the registry it is given. */
export function harnessSkillSources<R extends Registry>(harnesses: R): Record<keyof R & string, { roots: readonly string[]; maxDepth?: number }> {
  return Object.fromEntries(Object.entries(harnesses).map(([id, { skills }]) => [
    id,
    { roots: skills.globalRoots, ...(skills.maxDepth === undefined ? {} : { maxDepth: skills.maxDepth }) },
  ])) as Record<keyof R & string, { roots: readonly string[]; maxDepth?: number }>;
}

/**
 * Ids of the harnesses a workspace created without an explicit choice includes, sorted by id.
 * The first one is the tool a workspace resumes with when none is named, so the order is fixed, not registry order.
 */
export function defaultWorkspaceHarnesses(harnesses: Registry = HARNESSES): string[] {
  return Object.entries(harnesses).filter(([, harness]) => harness.defaultForNewWorkspaces).map(([id]) => id).sort();
}

// The GUI

export interface HarnessSummary {
  id: string;
  name: string;
  workspaceSkillFolder: WorkspaceSkillFolder;
  globalSkillRoots: string[];
  history: boolean;
  instructionsFile: string | null;
}

/** What the GUI may know about each harness; the launch details stay on the server. */
export function harnessSummaries(harnesses: Registry = HARNESSES): HarnessSummary[] {
  return Object.entries(harnesses).map(([id, harness]) => ({
    id,
    name: harness.name,
    workspaceSkillFolder: harness.skills.workspaceFolder,
    globalSkillRoots: [...harness.skills.globalRoots],
    history: harness.history,
    instructionsFile: harness.instructions?.outputFile ?? null,
  }));
}
