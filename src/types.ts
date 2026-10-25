/**
 * @module types
 * Shared interfaces and types for NexusFlow.
 */

import type {
  NormalizedUsage,
  NormalizedRemainingQuota,
  QuotaWindow,
  CostConfidence,
} from './harness/types.js';
import type { KnowledgeLesson } from './core/knowledge.js';

export type {
  NormalizedUsage,
  NormalizedRemainingQuota,
  QuotaWindow,
  CostConfidence,
};

/** Supported AI assistant identifiers. */
export type AIAssistant = 'claude' | 'antigravity' | 'codex' | 'copilot' | 'cursor';
/** CLI histories may come from tools that do not generate workspace resources. */
export type SessionAssistant = AIAssistant | 'pi';

/** Top-level NexusFlow configuration stored in ~/.nexusflow/config.json. */
export interface NexusFlowConfig {
  /** Semantic version of the NexusFlow config schema. */
  version: string;

  /** Root development directory. Default: ~/dev */
  devDir: string;

  /** Directory where workspaces are created. Default: ~/dev/workspaces */
  workspacesDir: string;

  /** The user's preferred AI assistant, or null if none chosen yet. */
  defaultAssistant: SessionAssistant | null;

  /** The user's preferred editor command, or null if none chosen yet. */
  defaultEditor?: string | null;

  /** How many directory levels deep to scan for git repos. Default: 2 */
  scanDepth: number;

  /** Global patterns to exclude when packing/analyzing repositories. */
  excludePatterns?: string[];

  /** Active storage provider name. Default: 'local' */
  storageProvider?: string;

  /** Per-adapter settings keyed by adapter name. */
  adapterConfig?: Record<string, Record<string, unknown>>;

  /** List of plugin paths or npm packages to load. */
  plugins?: string[];

  /** ISO timestamp of the last update check. */
  lastUpdateCheck?: string;

  /** The last checked latest version from NPM. */
  latestVersion?: string;
  latestDownloadUrl?: string | null;
  latestReleaseNotes?: string;

}

/** Result of probing for an AI assistant on the system. */
export interface DetectedAI {
  /** Canonical assistant identifier. */
  name: SessionAssistant;

  /** Human-readable label shown in prompts. */
  displayName: string;

  /** Whether the assistant's CLI was found. */
  detected: boolean;

  /** The CLI command that was detected (e.g. 'claude', 'antigravity'). */
  command?: string;
}

/** Result of probing for a code editor on the system. */
export interface DetectedEditor {
  /** Human-readable editor name. */
  name: string;

  /** CLI command used to launch the editor. */
  command: string;

  /** Whether the editor's CLI was found in PATH. */
  detected: boolean;
}

/** Stable launch targets exposed to the GUI. Executables and URIs stay server-owned. */
export type WorkspaceLaunchTargetKind = 'ai-app' | 'editor';

export type WorkspaceLaunchIcon =
  | 'codex'
  | 'claude'
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'antigravity'
  | 'powershell'
  | 'cmd'
  | 'terminal'
  | 'intellij'
  | 'webstorm'
  | 'pycharm'
  | 'sublime'
  | 'zed'
  | 'windsurf';

export interface WorkspaceLaunchTarget {
  /** Closed identifier accepted by the launch endpoint (never an executable name from the client). */
  id: string;
  name: string;
  description: string;
  kind: WorkspaceLaunchTargetKind;
  icon: WorkspaceLaunchIcon;
  available: boolean;
  unavailableReason?: string;
}

/** Metadata about a discovered git repository. */
export interface RepoInfo {
  /** Directory name of the repo. */
  name: string;

  /** Absolute path to the repo root. */
  path: string;

  /** Default branch — typically 'main' or 'master'. */
  defaultBranch: string;
}

/** A repo chosen for a new workspace, with an optional branch override. */
export interface RepoSelection extends RepoInfo {
  /**
   * Existing branch to check out for this repo instead of creating the
   * feature branch. Must already exist locally or on origin.
   */
  existingBranch?: string;
}

/** Metadata about a past AI session. */
export interface AISession {
  id: string;
  assistant: SessionAssistant;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspacePath: string;
  /** Only classify using provider metadata, never prompt text or a title. */
  threadKind?: 'main' | 'subagent' | 'unknown';
  parentSessionId?: string;
  /** Unmodified cwd from the provider record, for canonical launch validation. */
  recordedCwd?: string;
  /**
   * Server-verified way to continue this exact local session in a Desktop app.
   * `direct` opens the existing task by provider deep link. `guided` uses the
   * provider's documented CLI-to-Desktop transfer because no direct link exists.
   */
  desktopHandoff?: {
    targetId: 'codex-desktop' | 'claude-desktop';
    method: 'direct' | 'guided';
  };
  /** Normalized token usage accumulated across the session, if parsed or available. */
  usage?: NormalizedUsage;
  /** Latest known remaining quota or context window limits, if available. */
  quota?: NormalizedRemainingQuota;
}

/** A single chat message in a session transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** Normalized token usage consumed during this turn, if available. */
  usage?: NormalizedUsage;
}


/** Configuration for resuming the active session. */
export interface ResumptionConfig {
  /** The command to run verification tests. */
  testCommand?: string;
  /** Explicit verification command override (alias for testCommand). */
  verifyCommand?: string;
  /** The command to spin up dev databases/mocks/caches. */
  mockCommand?: string;
  /** The command to start workspace services manually if needed. */
  startCommand?: string;
}

/** A repository belonging to a {@link Project}. */
export interface ProjectRepo {
  /** Absolute path to the source repository. */
  path: string;
  /** Default branch of the repo (e.g. 'main' or 'master'). */
  defaultBranch: string;
}

/**
 * A named, persistent group of source repositories that features are started
 * from. Projects live in a central registry (~/.nexusflow/projects.json) and
 * never own worktrees or branches themselves — they are the durable "what do
 * I work on" grouping that outlives any individual feature workspace.
 */
export interface Project {
  /** Unique identifier — slugified from the name. */
  id: string;
  /** Human-readable project name. */
  name: string;
  /** Optional short description. */
  description?: string;
  /** Repositories in this project. */
  repos: ProjectRepo[];
  /** ISO-8601 timestamp of when the project was registered. */
  createdAt: string;
  /** ISO-8601 timestamp of the last registry update. */
  updatedAt: string;
}

/**
 * How a feature attaches to its repos:
 * - `worktree` — each repo is checked out as an isolated git worktree inside
 *   the workspace directory (the classic flow).
 * - `in-place` — the feature points at the source repositories directly; no
 *   branches or worktrees are created and the workspace directory only holds
 *   the manifest and generated context files.
 */
export type WorkspaceMode = 'worktree' | 'in-place';

/** Metadata for a repository dynamically isolated into a worktree on-demand. */
export interface IsolatedRepoInfo {
  /** Absolute path to the isolated worktree directory. */
  worktreePath: string;
  /** Git branch name checked out in this worktree. */
  branchName: string;
  /** Base branch the feature branch was created from, if known. */
  baseBranch?: string;
  /** ISO-8601 timestamp of when isolation occurred. */
  isolatedAt: string;
}

/** A feature workspace that spans one or more repos. */
export interface Feature {
  workType?: 'bug' | 'feature' | 'performance' | 'refactor' | 'rewrite';
  /** Explicit lifecycle preset, preserved independently of branch naming. */
  flowType?: 'quick' | 'feature' | 'epic';
  /** Unique identifier — the git branch name (worktree mode) or slugified workspace name (in-place mode). */
  id: string;

  /** Repo attachment mode. Absent in manifests written before modes existed — treat as 'worktree'. */
  mode?: WorkspaceMode;

  /** Id of the {@link Project} this feature was created from, if any. */
  projectId?: string;

  /** Git branch name created for this feature. */
  branchName: string;

  /** Human-readable workspace name, independent of its directory and Git branch. */
  name?: string;

  /** Short human-readable description of the feature. */
  description: string;

  /** Absolute paths to the repos included in this feature. */
  repos: string[];

  /** Absolute paths to the original repositories. */
  originalRepos?: string[];

  /**
   * Per-repo branch overrides (repo name → existing branch that was checked
   * out instead of {@link branchName}). Absent for repos on the feature branch.
   */
  repoBranches?: Record<string, string>;

  /**
   * For in-place features, repos that have been dynamically isolated into
   * dedicated worktrees on-demand (keyed by repo directory name).
   */
  isolatedRepos?: Record<string, IsolatedRepoInfo>;

  /**
   * Branches this workspace created (repo name → branch), as opposed to
   * branches that already existed. Archive only ever deletes these.
   */
  createdBranches?: Record<string, string>;

  /** AI assistants enabled for this feature workspace. */
  assistants: SessionAssistant[];

  /** Absolute path to the workspace directory on disk. */
  workspacePath: string;

  /** ISO-8601 timestamp of when the feature was created. */
  createdAt: string;

  /** Resumption configuration. */
  resumption?: ResumptionConfig;

  /** Custom teamwork coordination instructions for the agent team. */
  teamworkInstructions?: string;

  /** Optional organization/company identifier (e.g. 'acme'). */
  organizationId?: string;

  /** Active domain packs for this workspace (e.g. ['economy']). */
  domainPacks?: string[];

  /** Explicit runtime/intra-repo seams that package dependency analysis cannot infer. */
  contracts?: Array<{
    from: string;
    to: string;
    kind: string;
    /** Knowledge heading id, e.g. 2026-08-25-bff-error-encoding. */
    entry: string;
  }>;

  /**
   * Set while the workspace is archived: its worktrees were returned, its
   * record is kept, and operations that change repositories or start
   * processes refuse it. Cleared by unarchive.
   */
  archivedAt?: string;

  /** What the latest archive removed and kept. Retained after unarchive as history. */
  archive?: ArchiveRecord;

  /** Earlier archive records, oldest first: archiving again never loses a delivery record. */
  archiveHistory?: ArchiveRecord[];
}

/** How one repository stood when its workspace was archived. */
export interface ArchivedRepoRecord {
  name: string;
  /** How the repository was attached before archive. */
  access: 'reference' | 'isolated' | 'worktree';
  /** The user's own checkout; archived workspaces read it as a reference. */
  sourcePath: string;
  /** The worktree archive removed, if any. */
  worktreePath?: string;
  /** Branch checked out in that worktree; `null` for a detached HEAD. */
  branch?: string | null;
  /** Final commit of the worktree, so the work can always be found again. */
  headSha?: string | null;
  /**
   * `merged`: proven part of the default branch. `parked`: pushed but not
   * merged, archived on explicit request. `reference`: never edited here.
   */
  branchState: 'merged' | 'parked' | 'reference';
  /** Evidence that proved a merge. */
  mergeEvidence?: 'ancestor' | 'pull-request';
  prUrl?: string;
  /** Archive deleted the local branch (its tip is {@link headSha}). */
  branchDeleted?: boolean;
  /** Archive deleted the branch on `origin`. */
  remoteBranchDeleted?: boolean;
}

/** Manifest record of an archive. */
export interface ArchiveRecord {
  archivedAt: string;
  /** Mode before archive; archived workspaces are always in-place references. */
  previousMode: WorkspaceMode;
  /** True when pushed-but-unmerged work was archived on explicit request. */
  parked: boolean;
  repos: ArchivedRepoRecord[];
  /** Set when the workspace was restored as active. */
  unarchivedAt?: string;
}

/** Per-repo journal entry of an archive run. */
export interface ArchiveRunRepo extends ArchivedRepoRecord {
  /** Whether this run has removed (or found removed) the worktree. */
  removed: boolean;
  error?: string;
}

/** Durable record of an archive run, so an interrupted run resumes. */
export interface ArchiveRun {
  startedAt: string;
  completedAt?: string;
  /** `running` means the process stopped mid-run; re-running resumes safely. */
  status: 'running' | 'completed' | 'partial';
  parked: boolean;
  repos: ArchiveRunRepo[];
}

/** Runtime context for an active workspace — now includes analysis data. */
export interface WorkspaceContext {
  /** The feature definition. */
  feature: Feature;

  /** Full repo metadata for every repo in the feature. */
  repos: RepoInfo[];

  /** Analysis results for each repo (keyed by repo path). */
  analysis?: Map<string, ProjectAnalysis>;

  /** The knowledge entries listed in AGENTS.md: the workspace's own, then its repos' base knowledge. Read when generating if absent. */
  lessons?: KnowledgeLesson[];

  /** Immutable repo snapshot captured before generated artifacts are rendered. */
  generation?: {
    generatedAt: string;
    toolVersion: string;
    repos: Record<string, { sha: string; fingerprint: string }>;
  };
}

// ─── Phase 2: Project Analysis Types ──────────────────────────────────────

/** Recognized language/runtime. */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'csharp'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'other';

/** Recognized framework. */
export type Framework =
  | 'react'
  | 'nextjs'
  | 'angular'
  | 'vue'
  | 'svelte'
  | 'express'
  | 'nestjs'
  | 'fastify'
  | 'hono'
  | 'aspnet'
  | 'blazor'
  | 'django'
  | 'flask'
  | 'fastapi'
  | 'gin'
  | 'spring'
  | 'rails'
  | 'laravel'
  | 'other';

/** Recognized project type. */
export type ProjectType =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'library'
  | 'api'
  | 'cli'
  | 'worker'
  | 'other';

/** Detected tech stack for a repo. */
export interface TechStack {
  languages: Language[];
  frameworks: Framework[];
  buildTools: string[];
  projectType: ProjectType;
}

/** An inter-repo dependency reference. */
export interface RepoDependency {
  /** Name of the dependency (npm package, NuGet package, etc.). */
  name: string;
  /** Type of dependency. */
  type: 'npm' | 'nuget' | 'pip' | 'go' | 'other';
  /** Version constraint if known. */
  version?: string;
}

/** Port/service configuration detected in a repo. */
export interface ServicePort {
  port: number;
  protocol: 'http' | 'https' | 'grpc' | 'other';
  source: string;
}

/** Full analysis result for a single project/repo. */
export interface ProjectAnalysis {
  /** Repo name. */
  name: string;
  /** Repo path. */
  path: string;
  /** Detected tech stack. */
  techStack: TechStack;
  /** Detected dependencies. */
  dependencies: RepoDependency[];
  /** Detected ports/services. */
  ports: ServicePort[];
  /** Summary from README.md if found. */
  readmeSummary: string | null;
  /** Existing AI config files found in the repo. */
  existingAIConfigs: ExistingAIConfig[];
  /** Produced/published packages by this repo. */
  produces?: { name: string; type: 'npm' | 'nuget' | 'other'; version?: string; contributing?: string[] }[];
  /** NuGet feeds detected in the repo's NuGet.config files. */
  nugetFeeds?: { name: string; url: string }[];
  /** Detected run configurations. */
  runConfig?: RunConfig;
}

/** Full analysis result for a single project/repo (alias: WorkspaceAnalysis). */
export type WorkspaceAnalysis = ProjectAnalysis;

// ApiEndpoint, MessagePublisher, MessageSubscriber and MessagingTopology are
// gone with detect-apis and messaging-analyzer, which reported header reads as
// HTTP routes and Set insertions as queue publishers. Nothing populated them
// afterwards, so they only described a shape no analysis produced.

export interface RunConfigEntryPoint {
  projectPath: string;
  type: string;
  command?: string;
  port?: number;
}

export interface RunConfigDatabase {
  provider: string;
  host: string;
  configFile: string;
}

export interface RunConfigSharedInfraWarning {
  resource: string;
  host: string;
  configFile: string;
  warning: string;
}

export interface RunConfigSecret {
  file: string;
  lineHint: string;
}

export interface RunConfig {
  entryPoints: RunConfigEntryPoint[];
  databases: RunConfigDatabase[];
  sharedInfraWarnings: RunConfigSharedInfraWarning[];
  committedSecrets: RunConfigSecret[];
  externalDependencies: string[];
}

/** An existing AI configuration file found in a repo. */
export interface ExistingAIConfig {
  /** Which assistant this config is for. */
  assistant: AIAssistant | 'agents';
  /** File path relative to repo root. */
  relativePath: string;
  /** First 500 chars of the content for context. */
  contentPreview: string;
}

// ─── Phase 3: Service Orchestration Types ─────────────────────────────────

/** How to start a single service/project. */
export interface ServiceConfig {
  /** Display name for the service. */
  name: string;
  /** Absolute path to the project directory. */
  cwd: string;
  /** The command to run (e.g., 'npm', 'dotnet', 'python'). */
  command: string;
  /** Arguments for the command. */
  args: string[];
  /** Optional port the service listens on. */
  port?: number;
  /** How the start command was detected. */
  source: 'package.json' | 'dotnet' | 'docker-compose' | 'aspire' | 'python' | 'go' | 'makefile' | 'manual' | 'procfile';
  /**
   * True when the repository declares this process (a `Procfile.dev` or
   * `Procfile` line). Everything else is guessed from project files; guessed
   * services can be started one at a time but never by Start All.
   */
  declared?: boolean;
  /** The file and 1-based line that declared this service. */
  declaredIn?: { file: string; line: number };
  /** The command as written, for display (a Procfile line runs through the shell). */
  display?: string;
  /** Environment set for this process only, such as the PORT a Procfile line is given. */
  env?: Record<string, string>;
}

/** Why a service did not start or stopped unexpectedly, kept beside its logs until the next action. */
export interface ServiceFailure {
  name: string;
  reason: string;
  at: string;
}

/** Outcome of starting one service. */
export interface ServiceStartResult {
  name: string;
  status: 'running' | 'failed';
  pid?: number;
  reason?: string;
}

/** Detected orchestration tool in a workspace. */
/** A structured, directly-executable command (never a shell string). */
export interface OrchestrationRun {
  command: string;
  args: string[];
  cwd: string;
}

export interface OrchestrationDetection {
  /** Stable identity: `${tool}:${config path relative to the scanned dir}`. */
  id: string;
  /** Which tool was found. */
  tool: 'docker-compose' | 'aspire' | 'tilt' | 'procfile' | 'makefile';
  /** Path to the config file. */
  configPath: string;
  /** Start command for this tool (display only — never executed). */
  startCommand: string;
  /** Stop command for this tool (display only — never executed). */
  stopCommand: string;
  /** The structured start invocation — the only thing ever executed. */
  run: OrchestrationRun;
  /** Structured stop invocation (one-shot tools like compose `down`). */
  stopRun?: OrchestrationRun;
  /**
   * How the tool runs: `oneshot` detaches by itself (compose up -d) and is
   * stopped via `stopRun`; `pm2` is wrapped like a service and stopped by
   * deleting its PM2 app.
   */
  mode: 'oneshot' | 'pm2';
}

/** A currently running service process. */
export interface RunningService {
  /** Service name. */
  name: string;
  /** Process ID. */
  pid: number;
  /** Service config used to start it. */
  config: ServiceConfig;
  /** Timestamp when started. */
  startedAt: string;
  /** Its log file, so an unexpected stop can quote the last line it wrote. */
  logFile?: string;
}

/** State file saved to track running services. */
/** A started orchestration tool recorded in the running state. */
export interface RunningOrchestrator {
  /** Matches {@link OrchestrationDetection.id}. */
  id: string;
  tool: OrchestrationDetection['tool'];
  configPath: string;
  mode: 'oneshot' | 'pm2';
  /** PM2 app name — set only for mode 'pm2'. */
  pm2Name?: string;
  /** Tailable log source name (e.g. `orch-<slug>`) — set only for mode 'pm2'. */
  logName?: string;
  startedAt: string;
}

export interface RunningState {
  /** Workspace path this state belongs to. */
  workspacePath: string;
  /** List of running services. */
  services: RunningService[];
  /**
   * Started orchestration tools. Kept separate from services: one-shot tools
   * (docker compose up -d) have no PID for the services filter to verify.
   */
  orchestrators?: RunningOrchestrator[];
  /** The latest failure per service, cleared when it starts or is stopped. */
  failures?: ServiceFailure[];
  /** Timestamp when the state was last updated. */
  updatedAt: string;
}

// ─── Per-Repo Sync State ──────────────────────────────────────────────────

/**
 * Classified outcome of a sync/rebase attempt for a single repo.
 * See `utils/multi-git.ts` for the meaning of each value.
 */
export type SyncStatus = 'up-to-date' | 'rebased' | 'conflict' | 'stash-conflict' | 'error';

/** At-a-glance status for one workspace, from GET /api/workspaces/status. */
export interface WorkspaceStatus {
  id: string;
  branchName: string;
  /** Total uncommitted files across all repo worktrees. */
  changedFiles: number;
  /** Number of repos with uncommitted changes. */
  dirtyRepos: number;
  /** Number of currently running orchestrated services. */
  runningServices: number;
  /** Worst-case sync classification across repos, or 'unknown' if never synced. */
  syncStatus: SyncStatus | 'unknown';
  /** True when any repo pulled in new commits and awaits re-validation. */
  pendingValidation: boolean;
  /** AI assistants that have active/recorded sessions in this workspace. */
  activeAssistants?: SessionAssistant[];
}

/** Persisted sync/validation state for a single repo in a workspace. */
export type VerificationStatus =
  | 'pass'
  | 'pass_dirty'
  | 'fail'
  | 'timeout'
  | 'no-tests'
  | 'skipped';

/** Detailed mechanical verification proof for a single repo. */
export interface RepoVerificationReport {
  repoName: string;
  repoPath: string;
  status: VerificationStatus;
  command: string;
  exitCode: number | null;
  headSha: string;
  clean: boolean;
  dirtyFiles?: string[];
  /**
   * Hash of the tested content (HEAD diff plus untracked files). A later
   * snapshot with a different fingerprint means the evidence is stale.
   */
  fingerprint?: string;
  /** Git tree hash of the tested working tree; equal after committing it unchanged. */
  contentTree?: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  verifiedAt: string;
}

/** Aggregate mechanical verification report across all repos in a workspace. */
export interface WorkspaceVerificationReport {
  workspacePath: string;
  overallStatus: VerificationStatus;
  canProgress: boolean;
  verifiedAt: string;
  durationMs: number;
  repos: RepoVerificationReport[];
}

/** Persisted sync/validation state for a single repo in a workspace. */
export interface RepoSyncState {
  /** Directory name of the repo. */
  repoName: string;
  /** ISO timestamp of the last sync attempt. */
  lastSyncedAt?: string;
  /** Classified result of the last sync. */
  lastSyncStatus?: SyncStatus;
  /** Human-readable message from the last sync. */
  lastSyncMessage?: string;
  /** True when the repo pulled in new commits and has not yet been re-validated. */
  pendingValidation?: boolean;
  /** Result of the last validation run (e.g. test/e2e), if any. */
  lastValidationResult?: 'pass' | 'fail' | null;
  /** ISO timestamp of the last validation run. */
  lastValidatedAt?: string;
  /** Last structured mechanical verification proof, if any. */
  lastVerification?: RepoVerificationReport;
}

export type LifecycleStepStatus =
  | 'pending'
  | 'in_progress'
  | 'verified'
  | 'completed'
  | 'blocked';

/** A vertical slice or discrete development milestone in the workspace lifecycle. */
export interface LifecycleStep {
  id: string;
  title: string;
  description?: string;
  branch?: string;
  repo?: string;
  workItem?: string;
  unblockCondition?: string;
  owner?: string;
  status: LifecycleStepStatus;
  dependsOn?: string[];
  verificationCommand?: string;
  /**
   * Time limit for this milestone's gate, in seconds. Gates default to
   * 30 minutes (DEFAULT_GATE_TIMEOUT_SECONDS); a gate that runs a full suite,
   * a build and browser tests may need more.
   */
  verificationTimeoutSeconds?: number;
  requiresVerification?: boolean;
  lastVerificationSha?: string;
  lastVerificationStatus?: VerificationStatus;
  completedAt?: string;
  /** Set while a finished milestone has been sent back for rework. Cleared when it completes again. */
  reopenedAt?: string;
  /** Why the milestone was reopened, in the words of whoever reopened it. */
  reopenReason?: string;
  reopenedBy?: 'user' | 'agent';
  /** How many times this milestone has been reopened. Survives completion. */
  reopenCount?: number;
  /** Set while the milestone is blocked on something outside the work itself. Cleared when it is started again. */
  blockedReason?: string;
  blockedAt?: string;
}

/** Information about sister branches and collaborator commits tracked in the workspace. */
export interface BranchFleetMember {
  branch: string;
  repoName: string;
  owner?: string;
  isCurrent: boolean;
  headSha?: string;
  ahead: number;
  behind: number;
  lastCommitMessage?: string;
  lastCommitAuthor?: string;
  lastCommitDate?: string;
  remoteTracked: boolean;
}

/** Machine-readable workspace lifecycle state. */
export interface WorkspaceLifecycle {
  revision?: number;
  workspaceId: string;
  flowType: 'quick' | 'feature' | 'epic';
  /** The milestone being worked on, by the plan's one rule (`planFocus`). */
  currentStepId?: string;
  /** The milestone to start next, by the same rule; it may still wait for something. */
  nextStepId?: string;
  steps: LifecycleStep[];
  fleet?: BranchFleetMember[];
  updatedAt: string;
  /**
   * Set once the milestones were moved into the plan store (`contextspace-plan.json`). From then on
   * the steps live there and this record keeps only the flow type.
   */
  movedToPlanAt?: string;
}

/** The latest check of one milestone on this machine. Machine-local, so it stays out of the committed plan. */
export interface PlanEvidence {
  lastVerificationSha?: string;
  lastVerificationStatus?: VerificationStatus;
  /** Whether the check permitted progress. */
  canProgress: boolean;
  /** When it ran. Missing for a check carried over from a lifecycle that did not keep the time. */
  at?: string;
}

/** State file saved to track per-repo sync/validation status (`.nexusflow-state.json`). */
export interface WorkspaceState {
  /** Workspace path this state belongs to. */
  workspacePath: string;
  /** Per-repo state, keyed by repo name. */
  repos: Record<string, RepoSyncState>;
  /** Most recent workspace-wide mechanical verification result. */
  lastVerification?: WorkspaceVerificationReport;
  /** Active structured lifecycle state machine. */
  lifecycle?: WorkspaceLifecycle;
  /** The latest check of each milestone, keyed by its plan code, from before the plan moved to PLAN.md. */
  planEvidence?: Record<string, PlanEvidence>;
  /** The latest check of each PLAN.md checkpoint, keyed by its key (core/plan-file). */
  planChecks?: Record<string, PlanEvidence>;
  /** Recent explicit verification overrides, newest last (bounded). */
  verificationOverrides?: VerificationOverrideRecord[];
  /** Durable record of the latest finish run, so it can be resumed after a restart. */
  lastFinish?: FinishRecord;
  /** Durable record of the latest archive run, so it can be resumed after a restart. */
  lastArchive?: ArchiveRun;
  /** Timestamp when the state was last updated. */
  updatedAt: string;
}

/** An explicit, reasoned decision to finish without fresh passing verification. */
export interface VerificationOverrideRecord {
  at: string;
  operation: 'finish';
  reason: string;
  /** What the policy would have blocked on, as shown to the caller. */
  blockers: string[];
}

/** Per-repo outcome of a finish run, as persisted. */
export interface FinishRepoRecord {
  name: string;
  committed: boolean;
  commitHash?: string;
  pushed: boolean;
  prUrl?: string;
  compareUrl?: string;
  skipped?: string;
  error?: string;
}

/** Durable record of a finish run. Git effects are not atomic across repos. */
export interface FinishRecord {
  startedAt: string;
  completedAt?: string;
  /** `running` means the process stopped mid-run; re-running resumes safely. */
  status: 'running' | 'completed' | 'partial' | 'blocked';
  repos: FinishRepoRecord[];
  override?: VerificationOverrideRecord;
  safeToCleanup: boolean;
}

// ─── Phase 3: Dependency Graph Types ──────────────────────────────────────

/** A node in the workspace dependency graph. */
export interface DependencyNode {
  /** Repository name. */
  repoName: string;
  /** Absolute path to the repository. */
  repoPath: string;
  /** Names of repos this one depends on. */
  dependsOn: string[];
  /** Names of repos that depend on this one. */
  dependedOnBy: string[];
}

/** The full dependency graph for a workspace. */
export type DependencyGraph = Map<string, DependencyNode>;

// ─── Skills & Agents Types ────────────────────────────────────────────────

/** A skill category (built-in template or user-customized). */
export interface SkillCategory {
  /** Slug identifier (e.g. 'pull-requests', 'testing-qa'). */
  id: string;
  /** Human-readable title (e.g. 'Pull Requests & Review'). */
  name: string;
  /** Description of the category domain. */
  description: string;
  /** Lucide icon identifier or emoji. */
  icon?: string;
  /** Hex color or badge theme class. */
  color?: string;
  /** Whether this is a user-created/customized category. */
  custom?: boolean;
  /** Whether this is a default template category. */
  isTemplate?: boolean;
  /** IDs of skills belonging to this category. */
  skills?: string[];
}

/** Parameter definition for a skill. */
export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Supporting reference document or script in a skill package. */
export interface SkillSupportingFile {
  name: string;
  relativePath: string;
  content?: string;
}

/** Where a skill lives when a harness (Claude Code, Codex, ...) owns it instead of the ContextSpace catalog. */
export interface SkillSource {
  /** Harness id from `CLI_HARNESSES`, e.g. 'claude'. */
  harness: string;
  /** Display name of that harness, e.g. 'Claude Code'. */
  label: string;
  /** Absolute, symlink-resolved skills folder the skill was found under. */
  root: string;
}

/** An agent skill item. */
export interface SkillItem {
  /** Unique skill identifier (slug, e.g. 'pr-review-toolkit'). */
  id: string;
  /** Normalized name. */
  name: string;
  /** Human-readable display title. */
  title?: string;
  /** Category ID or Name this skill belongs to. */
  category: string;
  /** Set when SKILL.md names no category, so `category` is the assumed 'general' rather than a choice. */
  categoryAssumed?: boolean;
  /** Trigger description and instructions overview. */
  description: string;
  /** Tags / Keywords for discovery. */
  tags?: string[];
  /** Optional company / organization identifier (e.g. 'acme'). */
  organization?: string;
  /** Optional domain subsystem this skill belongs to (e.g. 'economy', 'hr'). */
  domain?: string;
  /** Allowed / required tool primitives. */
  allowedTools?: string[];
  /** Typed arguments / parameters. */
  parameters?: SkillParameter[];
  /** Main markdown content (playbook instructions). */
  content: string;
  /** The SKILL.md file exactly as written, frontmatter included. Shown in the Raw view. */
  rawFile?: string;
  /** Whether this is a user-created or customized skill. */
  custom: boolean;
  /** Absolute source directory path if loaded from disk. */
  sourcePath?: string;
  /** Subordinate reference docs inside `references/`. */
  references?: SkillSupportingFile[];
  /** Helper scripts inside `scripts/`. */
  scripts?: SkillSupportingFile[];
  /** Static assets, schemas, templates, diagrams inside `assets/`. */
  assets?: SkillSupportingFile[];
  /** Scope of the skill: 'workspace' for project-specific or 'global' for machine-wide catalog. */
  scope?: 'workspace' | 'global';
  /** Present when a harness owns this skill. It is listed read-only: edit or delete it in the harness. */
  source?: SkillSource;
  /** Additional frontmatter metadata (custom properties, deeply nested configurations, etc.). */
  metadata?: Record<string, unknown>;
  /** Optional license expression or identifier. */
  license?: string;
  /** Optional environment/assistant compatibility statement. */
  compatibility?: string;
}

/** Options for saving a skill to the global or workspace catalog. */
export interface SaveSkillOptions {
  scope?: 'workspace' | 'global';
  workspacePath?: string;
  category?: string;
  overwrite?: boolean;
  readonly beforeCommit?: () => Promise<void>;
  readonly supportFileModes?: Readonly<Record<string, number>>;
}

/** A reusable Codex custom-agent definition. */
export interface CodexAgentItem {
  /** Unique catalog identifier (lowercase slug). */
  id: string;
  /** Native Codex agent name. */
  name: string;
  /** Category ID used only for NexusFlow organization. */
  category: string;
  /** Human-facing guidance for when Codex should use the agent. */
  description: string;
  /** Optional model override. Omit to inherit Codex session settings. */
  model?: string;
  /** Optional Codex reasoning-effort override. */
  modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** Optional sandbox default. Parent live overrides can still take precedence. */
  sandboxMode?: 'read-only' | 'workspace-write';
  /** Native Codex developer instructions. */
  developerInstructions: string;
  /** Whether this is a user-created agent. */
  custom: boolean;
  /** Absolute catalog source path when loaded from disk. */
  sourcePath?: string;
}

/** Workspace skill assignments state. */
export interface WorkspaceSkillsConfig {
  /** Persisted contract version. */
  schemaVersion?: 1;
  /** Optimistic concurrency token for assignment edits. */
  revision?: number;
  /** Active enabled skill IDs. */
  enabledSkills: string[];
  /** Explicitly disabled skill IDs (persisted opt-out). */
  disabledSkills?: string[];
  /** Active Codex custom-agent IDs. */
  enabledAgents?: string[];
  /** Active enabled category IDs. */
  enabledCategories?: string[];
}

/** Universal conventions for a company / organization (e.g. Acme). */
export interface OrganizationConventions {
  /** Unique slug (e.g. 'acme'). */
  id: string;
  /** Human-readable company name. */
  name: string;
  /** Regex pattern enforced on commit messages (e.g. Jira issue key format). */
  commitMessagePattern?: string;
  /** Example commit message compliant with company standard. */
  commitExample?: string;
  /** Relative path to PR template file. */
  prTemplate?: string;
  /** Universal company rules injected into all assistant contexts. */
  rules: string[];
  /** True if this is a sample starter template rather than a user-created organization. */
  isTemplate?: boolean;
}

export type CategoryType = 'vertical' | 'trait';

/** Microservice / repository binding with target mode ('edit' vs 'reference'). */
export interface CategoryRepoBinding {
  name: string;
  target?: 'edit' | 'reference';
  description?: string;
  suggestedTestCommand?: string;
}

/** A modular category & tag pack scoped to a subsystem or cross-cutting trait. */
export interface DomainPack {
  /** Unique category / tag slug (e.g. 'economy', 'workforce/payroll', 'compliance/gdpr'). */
  id: string;
  /** Human-readable category name (e.g. 'Economy & Invoicing', 'Payroll'). */
  name: string;
  /** Description of this subsystem's scope and rules. */
  description: string;
  /** Parent category slug for tree hierarchy (e.g. 'workforce' for 'workforce/payroll'). */
  parent?: string;
  /** Category classification: 'vertical' (business subsystem) or 'trait' (cross-cutting horizontal). */
  categoryType?: CategoryType;
  /** Associated organization ID if company-specific. */
  organization?: string;
  /** Keywords / tags for discovery and auto-matching from specs. */
  tags: string[];
  /** IDs of skills bundled in this category pack. */
  skills?: string[];
  /** Relative or absolute paths to reference context documents. */
  contextFiles?: string[];
  /** Category-specific mechanical verification command override. */
  verifyCommand?: string;
  /** Architectural, domain, or compliance rules. */
  rules?: string[];
  /** Repositories typically associated with this category. */
  defaultRepos?: string[];
  /** Microservice bindings with edit vs reference modes. */
  microservices?: CategoryRepoBinding[];
  /** True if this is a sample starter template rather than a user-created pack. */
  isTemplate?: boolean;
  /** True if this pack originated from built-in starter templates. */
  builtin?: boolean;
}

/** Alias for DomainPack reflecting hierarchical Category & Tag Tree architecture. */
export type CategoryTagPack = DomainPack;

export interface ResolvedCategoryRules {
  organization: OrganizationConventions | null;
  domainPacks: DomainPack[];
  verticals: DomainPack[];
  traits: DomainPack[];
  allRules: string[];
  compositeVerifyCommand?: string;
  editRepos: string[];
  referenceRepos: string[];
}
