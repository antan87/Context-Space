import { listRepositoryChangesWithFingerprint, parseGitStatus } from './core/repository-changes.js';
import { resolveFileReference } from './core/file-reference-resolve.js';
import { decodeImageAttachment, InvalidImageAttachment } from './services/image-attachment.js';
import { registerTerminalRoutes, terminalManager } from './terminal/routes.js';
import { registerWorkGuidanceRoutes } from './http/work-guidance-routes.js';
import { registerPlanRoutes } from './http/plan-routes.js';
import { registerNeedsYouRoute } from './http/needs-you-routes.js';
import { extractAstSymbols } from './services/symbolService.js';
import { looksBinary, MAX_VIEWABLE_FILE_BYTES, readRepositoryFileForView, RepositoryFileAccessError, resolveRepositoryFileForLaunch, type OmittedReason } from './services/repository-file.js';
/**
 * @module server
 * Hono local web server for the NexusFlow GUI.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { createNodeWebSocket } from '@hono/node-ws';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import { loadConfig, saveConfig, getConfigDir, getDefaultConfig } from './core/config.js';
import { checkConfigPaths, expandHome } from './core/config-paths.js';
import { saveChatThread, loadChatThread, clearChatThread } from './storage/db.js';
import { dataRoutes } from './diagnostics/routes.js';
import {
  PRIMARY_LOGS_DIR,
  LEGACY_LOGS_DIR,
  WORKROOM_BOOTSTRAP_HEADERS,
  WORKROOM_BOOTSTRAP_COOKIES,
  ENGINE_ID,
  LEGACY_ENGINE_ID,
  ENGINE_NPM_PACKAGE,
  LEGACY_ENGINE_NPM_PACKAGE,
  resolveWorkspaceChatLedger,
  readWorkspaceChatMessages,
  BRAND_NAME,
} from './core/constants.js';
import { configPatchSchema } from './core/config-schema.js';
import { countRequest, installPerfCounters, resetPerfCounters, snapshotPerfCounters } from './core/perf-counters.js';
import { listStorageProviders } from './core/adapters/registry.js';
import { scanForRepos } from './core/scanner.js';
import { createNewRepo, isValidProjectName } from './core/new-repo.js';
import { loadProjects, createProject, updateProject, removeProject, slugifyProjectName } from './core/projects.js';
import { getSessionCwd, isInPlace, resolveFeatureRepoPath } from './utils/feature.js';
import { listBranches } from './utils/git.js';
import {
  checkRepoFreshness,
  checkReposFreshness,
  fastForwardRepos,
} from './utils/repo-freshness.js';
import { createWorkspace, listWorkspaces, loadFeatureConfig, saveFeatureConfig, loadWorkspaceManifest, deleteWorkspace, addRepoToWorkspace, isolateWorkspaceRepo } from './core/workspace.js';
import { loadWorkspaceState } from './core/workspace-state.js';
import { acknowledgeInputRequests, latestInputRequest, type InputRequest } from './core/attention.js';
import { answerChatQuestionsInPlan } from './core/plan-questions.js';
import {
  ScreenSharingOffError, getScreenSharing, readScreenContext, saveScreenContext, setScreenSharing,
} from './core/screen-context.js';
import { watchLiveEvents, type LiveEvent } from './core/screen-events.js';
import { analyzeAllRepos } from './analyzers/index.js';
import { generateContextFiles } from './generators/index.js';
import {
  getAvailableOrganizations,
  getAvailableDomainPacks,
  getOrganization,
  getDomainPack,
  matchDomainPacks,
  resolveActiveDomainRules,
  saveDomainPack,
  deleteDomainPack,
  saveOrganization,
  deleteOrganization,
} from './core/domain-packs.js';

import { detectAIAssistants } from './utils/detect-ai.js';
import { detectEditors } from './utils/detect-editors.js';
import {
  buildWorkspaceLaunchPrompt,
  detectWorkspaceLaunchTargets,
  launchTargetIdForEditorCommand,
  launchWorkspaceTarget,
} from './utils/workspace-launch.js';
import { buildHarnessCliCommand, buildHarnessContinueCommand, isBinaryOnPath, launchWorkspaceTerminal, SUPPORTED_ASSISTANTS } from './utils/terminal-launch.js';
import { openInEditor } from './utils/open-editor.js';
import {
  canOpenCodexSessionInWorkspace,
  canTransferClaudeSessionInWorkspace,
  findActiveAssistants,
  findSessions,
  getSessionTranscript,
  SESSION_SOURCES,
} from './utils/session-finder.js';
import { ProviderRegistry } from './agent/adapters.js';
import { isValidSessionId, isValidSessionUuid, type AgentSession } from './agent/session.js';
import { defaultTurnSessionManager, AgentTurnGate, dispatchAgentInput } from './agent/TurnSessionManager.js';
import { getRepoStatus } from './utils/multi-git.js';
import { syncWorkspace } from './core/sync.js';
import { commitWorkspace, pushWorkspace } from './core/commit.js';
import { finishWorkspace } from './core/finish.js';
import { IsolationConflictError, planRepoIsolation } from './core/isolate.js';
import { ReferenceRepoError, describeEditBoundaries, referenceRepoMessage } from './core/edit-policy.js';
import { ArchivedWorkspaceError, assertWorkspaceActive } from './core/archive-guard.js';
import { archiveWorkspace, unarchiveWorkspace } from './core/archive.js';
import { evaluateProgression } from './core/progression-policy.js';
import { getWorkspaceStatusReport } from './core/status.js';
import { refreshWorkspace } from './core/refresh.js';
import { checkGenerationLock } from './core/generation-lock.js';
import { writeWorkspaceFile } from './core/storage.js';
import {
  readWorkspaceKnowledge,
  addWorkspaceKnowledge,
  addBaseKnowledge,
  KnowledgeRepositoryError,
  type KnowledgeEntryType,
} from './core/knowledge.js';
import {
  addSchedule,
  loadSchedules,
  nextDueAt,
  parseInterval,
  removeSchedule,
  runJob,
  setScheduleEnabled,
  startScheduler,
} from './core/scheduler.js';
import {
  detectAllServices,
  suggestProcfiles,
  detectOrchestrationTools,
  startServices,
  stopServices,
  startService,
  stopService,
  restartService,
  startOrchestrator,
  stopOrchestrator,
  stopRecordedOrchestrator,
  tailLogFile,
  loadRunningState,
  readPm2List,
} from './orchestration/index.js';
import { checkForUpdates, getCurrentVersion, getToolsStatus } from './utils/update-check.js';
import { getWorkflowTemplates, saveWorkflowTemplate, deleteWorkflowTemplate } from './utils/workflows.js';
import {


  getSkillCategories,
  saveSkillCategory,
  deleteSkillCategory,
  getAllSkills,
  saveSkill,
  deleteSkill,
  getWorkspaceSkillsConfig,
  saveWorkspaceSkillsConfig,
  WorkspaceResourceRevisionError,
} from './utils/skills-catalog.js';
import {
  deleteAgent,
  getAllAgents,
  importAgentToml,
  saveAgent,
} from './resources/agents-catalog.js';
import { ResourceConflictError } from './resources/materializer.js';
import {
  ResourceSelectionError,
  previewResourceSelections,
  validateResourceSelections,
  withResourceAdministrationLock,
} from './resources/service.js';

import type { AIAssistant, Feature, RepoInfo, RepoSelection, WorkspaceContext, SyncStatus, RepoSyncState, WorkspaceStatus, OrganizationConventions, DomainPack } from './types.js';
import { suggestWorkflow } from './utils/workflow-advisor.js';
import {
  WorkroomAuthorizationError,
  WorkroomRevisionError,
  WorkroomValidationError,
  documentNameSchema,
  workflowStepSchema,
} from './workrooms/contracts.js';
import { listWorkroomNetworkInterfaces } from './workrooms/host.js';
import * as workroomManagerModule from './workrooms/manager.js';
const { workroomManager } = workroomManagerModule;
import { buildPortableWorkroomPreview, digestPortableWorkroomContext } from './workrooms/portable.js';
import { randomToken, tokenDigest } from './workrooms/crypto.js';

// Resolve static files directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In development, the static GUI is built to dist/gui
// In production, it will be served from dist/gui as well
const guiPath = path.join(__dirname, 'gui');

export const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

function hasTrustedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export { dispatchAgentInput, AgentTurnGate };

app.get('/ws', async (c, next) => {
  // Prevent Cross-Site WebSocket Hijacking (CSWSH)
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const { hostname } = new URL(origin);
      const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
      if (!isLocal) return c.text('Forbidden', 403);
    } catch {
      return c.text('Forbidden', 403);
    }
  }
  
  // Chat protocol:
  //   client -> server: {type:'start', command, cwd, sessionId?, resume?}
  //                    | {type:'input', input, turnId?, executionProfile?} | {type:'stop'} | 'ping'
  //   server -> client: {type:'stream', text} | {type:'session', id} | {type:'status', state:'busy'|'idle'} | {type:'system', message}
  //                     | {type:'accepted', turnId?} | {type:'error', message}
  //                     | {type:'rejected', reason:'busy', message, turnId?}
  //                     | {type:'close', code} | {type:'pong'}
  return upgradeWebSocket((c) => {
    let currentCwd: string | null = null;
    let currentWs: { send: (data: string) => void } | null = null;

    return {
      async onMessage(event, ws) {
        currentWs = ws;
        if (typeof event.data === 'string') {
          if (event.data === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            } else if (payload.type === 'start') {
              const command = payload.command;
              const cwd = payload.cwd;
              if (typeof cwd !== 'string' || !cwd.trim()) {
                ws.send(JSON.stringify({ type: 'error', message: 'Workspace directory cwd is required.' }));
                return;
              }
              const provider = ProviderRegistry.getProvider(command);
              if (!provider) {
                ws.send(JSON.stringify({ type: 'error', message: `No provider found for ${command}. Please create a dedicated adapter.` }));
                return;
              }

              const config = await loadConfig();
              const safeCwd = await resolveExactLaunchWorkspace(config.workspacesDir, cwd);
              if (!safeCwd) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid or uncontained workspace directory.' }));
                return;
              }
              currentCwd = safeCwd;

              let session: AgentSession | undefined;
              const model = ProviderRegistry.resolveModel(provider, payload.model);
              if (model === null) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: `The selected model is not available for ${provider.name}. Choose a model advertised by this provider or use Automatic.`,
                }));
                return;
              }
              const effort = typeof payload.effort === 'string' && payload.effort.trim() ? payload.effort.trim() : undefined;
              if (payload.sessionId !== undefined && payload.sessionId !== null) {
                if (!isValidSessionUuid(payload.sessionId)) {
                  ws.send(JSON.stringify({ type: 'error', message: 'Invalid session id.' }));
                  return;
                }
                session = { id: payload.sessionId, resume: Boolean(payload.resume), model, effort };
              } else if (model || effort) {
                session = { id: crypto.randomUUID(), resume: false, model, effort };
              }

              await defaultTurnSessionManager.startSession({
                workspaceCwd: safeCwd,
                command,
                client: ws,
                provider,
                session,
              });
            } else if (payload.type === 'input') {
              const cwd = typeof payload.cwd === 'string' ? payload.cwd : currentCwd;
              if (!cwd) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'No active agent session. Please start or reconnect the agent.',
                }));
                return;
              }
              const config = await loadConfig();
              const safeCwd = await resolveExactLaunchWorkspace(config.workspacesDir, cwd);
              if (!safeCwd) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid workspace directory.' }));
                return;
              }
              currentCwd = safeCwd;

              const existingSession = defaultTurnSessionManager.getSession(safeCwd);
              if (!existingSession) {
                const command = typeof payload.command === 'string' ? payload.command : 'antigravity-cli';
                const provider = ProviderRegistry.getProvider(command);
                if (!provider) {
                  ws.send(JSON.stringify({ type: 'error', message: `No provider found for ${command}.` }));
                  return;
                }
                await defaultTurnSessionManager.startSession({
                  workspaceCwd: safeCwd,
                  command,
                  client: ws,
                  provider,
                });
              }

              const result = defaultTurnSessionManager.dispatchInput(safeCwd, payload);
              if (result.error) {
                ws.send(JSON.stringify({ type: 'error', message: result.error }));
              } else if (result.rejected) {
                const turnId = isValidSessionUuid(payload.turnId) ? payload.turnId : undefined;
                ws.send(JSON.stringify({
                  type: 'rejected',
                  reason: 'busy',
                  message: 'The agent is still processing the current turn.',
                  ...(turnId ? { turnId } : {}),
                }));
              }
            } else if (payload.type === 'approval_response') {
              if (currentCwd) {
                const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
                const decision = payload.decision === 'allow' ? 'allow' : 'deny';
                const message = typeof payload.message === 'string' ? payload.message : undefined;
                defaultTurnSessionManager.respondToApproval(currentCwd, requestId, decision, message);
              }
            } else if (payload.type === 'stop') {
              if (currentCwd) {
                defaultTurnSessionManager.stopSession(currentCwd);
              }
            }
          } catch (err) {
            console.error('Error handling WebSocket message:', err);
          }
        }
      },
      onOpen(_event, ws) {
        currentWs = ws;
      },
      onClose(_event, ws) {
        if (currentCwd && ws) {
          defaultTurnSessionManager.unregisterClient(currentCwd, ws);
        }
      },
    };
  })(c, next);
});

// Allowed editor binaries/scripts to prevent command injection
const ALLOWED_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'antigravity', 'agy', 'idea', 'charm', 'webstorm', 'subl', 'nano', 'vim', 'nvim', 'emacs', 'windsurf', 'zed']);

// A patch is allowed to be a few times the largest file shown in full: it holds both sides.
const MAX_DIFF_BYTES = MAX_VIEWABLE_FILE_BYTES * 4;

// ─── Path containment guards ──────────────────────────────────────────────
// The server exposes state-changing routes keyed by a workspace `:id` taken
// straight from the URL. Without containment checks, `..%2f..` sequences let a
// caller read/write/delete files outside the workspaces root. Every handler
// that turns an id (or repo name) into a filesystem path must go through these.

/** Thrown when a requested path escapes its permitted base directory. */
export class PathAccessError extends Error {
  constructor(message = 'Invalid workspace path') {
    super(message);
    this.name = 'PathAccessError';
  }
}

/** Resolve `target` and assert it stays within `baseDir` (or equals it). */
function assertWithin(baseDir: string, target: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  const isWin = process.platform === 'win32';
  const normBase = isWin ? base.toLowerCase() : base;
  const normResolved = isWin ? resolved.toLowerCase() : resolved;
  const sep = isWin ? path.sep.toLowerCase() : path.sep;

  // Trailing separator prevents a sibling like `feat-secret` from passing the
  // prefix test for base `feat`.
  if (normResolved !== normBase && !normResolved.startsWith(normBase + (normBase.endsWith(sep) ? '' : sep))) {
    throw new PathAccessError();
  }
  return resolved;
}

/** Safe workspace directory for a route `:id`, contained within workspacesDir. */
export function resolveWorkspacePath(workspacesDir: string, id: string): string {
  return assertWithin(workspacesDir, path.join(workspacesDir, id));
}

const DESKTOP_HANDOFF_SCAN_LIMIT = 20;

/**
 * Claude's documented `/desktop` transfer is narrower than its URI handler:
 * it requires macOS or x64 Windows, a subscription login, and a usable CLI.
 */
export function canOfferClaudeDesktopTransfer(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  isCliConfigured: () => boolean = () => {
    try {
      const provider = ProviderRegistry.getProvider('claude-cli');
      if (provider?.isConfigured()) return true;
    } catch {}
    return isBinaryOnPath('claude');
  },
): boolean {
  const supportedPlatform = platform === 'darwin' || (platform === 'win32' && architecture === 'x64');
  const usesUnsupportedAuth = Boolean(
    env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN
    || env.CLAUDE_CODE_USE_BEDROCK === '1'
    || env.CLAUDE_CODE_USE_VERTEX === '1'
    || env.CLAUDE_CODE_USE_FOUNDRY === '1',
  );
  if (!supportedPlatform || usesUnsupportedAuth) return false;
  try {
    return isCliConfigured();
  } catch {
    return false;
  }
}

/**
 * Resolve a launch path through the filesystem and require it to be the exact
 * workspace declared by its manifest. This prevents symlink escapes and stops
 * loadFeatureConfig's parent-directory fallback from authorizing a child path.
 */
async function resolveExactLaunchWorkspace(
  workspacesDir: string,
  candidatePath: string,
): Promise<string | null> {
  const lexicalPath = assertWithin(workspacesDir, candidatePath);
  const [canonicalRoot, canonicalWorkspace] = await Promise.all([
    fs.realpath(workspacesDir),
    fs.realpath(lexicalPath),
  ]);
  const safeWorkspacePath = assertWithin(canonicalRoot, canonicalWorkspace);
  const feature = await loadWorkspaceManifest(safeWorkspacePath);
  if (!feature || typeof feature.workspacePath !== 'string') return null;

  try {
    const declaredWorkspace = await fs.realpath(path.resolve(feature.workspacePath));
    const isWin = process.platform === 'win32';
    const normDeclared = isWin ? path.resolve(declaredWorkspace).toLowerCase() : path.resolve(declaredWorkspace);
    const normSafe = isWin ? path.resolve(safeWorkspacePath).toLowerCase() : path.resolve(safeWorkspacePath);
    return normDeclared === normSafe
      ? safeWorkspacePath
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a launch path under devDir to a source repository: after links are
 * resolved it must stay inside devDir and be a git repository itself. A parent
 * folder, an unrelated project, or a link that leads out of devDir is refused.
 */
async function resolveSourceRepository(
  devDir: string,
  candidatePath: string,
): Promise<string | null> {
  try {
    const [canonicalRoot, canonicalRepo] = await Promise.all([
      fs.realpath(devDir),
      fs.realpath(candidatePath),
    ]);
    const safeRepoPath = assertWithin(canonicalRoot, canonicalRepo);
    // `.git` is a directory in a clone and a file in a linked worktree.
    await fs.access(path.join(safeRepoPath, '.git'));
    return safeRepoPath;
  } catch {
    return null;
  }
}

/** Safe sub-repo path for a repo name, contained within the workspace. */
export function resolveRepoPath(workspacePath: string, repoName: string): string {
  return assertWithin(workspacePath, path.join(workspacePath, repoName));
}

/** Consistent error response; path-containment violations map to 400. */
function errorResponse(c: any, error: unknown) {
  if (error instanceof PathAccessError || error instanceof KnowledgeRepositoryError) {
    return c.json({ error: error.message }, 400);
  }
  if (error instanceof ResourceConflictError || error instanceof WorkspaceResourceRevisionError) {
    return c.json({
      error: error.message,
      conflicts: error instanceof ResourceConflictError ? error.conflicts : undefined,
    }, 409);
  }
  if (error instanceof ResourceSelectionError) {
    return c.json({
      error: error.message,
      missingSkills: error.missingSkills,
      missingAgents: error.missingAgents,
    }, 400);
  }
  if (error instanceof WorkroomAuthorizationError) {
    return c.json({ error: error.message }, 401);
  }
  if (error instanceof WorkroomRevisionError) {
    return c.json({
      error: error.message,
      expectedRevision: error.expected,
      actualRevision: error.actual,
    }, 409);
  }
  if (error instanceof WorkroomValidationError) {
    return c.json({ error: error.message }, 400);
  }
  if (error instanceof ReferenceRepoError) {
    return c.json({ error: error.message, code: error.code, repos: error.repos }, 409);
  }
  if (error instanceof ArchivedWorkspaceError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof IsolationConflictError) {
    return c.json({ error: error.message, code: error.code, plan: error.plan }, 409);
  }
  const msg = error instanceof Error ? error.message : String(error);
  return c.json({ error: msg }, 500);
}

async function resolveExactWorkspaceById(workspacesDir: string, id: string): Promise<string | null> {
  const candidate = resolveWorkspacePath(workspacesDir, id);
  try {
    return await resolveExactLaunchWorkspace(workspacesDir, candidate);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function findResourceAssignments(
  workspacesDir: string,
  resourceId: string,
  kind: 'skill' | 'agent',
): Promise<string[]> {
  const assignments: string[] = [];
  for (const workspace of await listWorkspaces(workspacesDir)) {
    const workspacePath = await resolveExactWorkspaceById(workspacesDir, workspace.id);
    if (!workspacePath) continue;
    const selection = await getWorkspaceSkillsConfig(workspacePath);
    const enabled = kind === 'skill' ? selection.enabledSkills : selection.enabledAgents ?? [];
    if (enabled.includes(resourceId)) assignments.push(workspace.id);
  }
  return assignments;
}

// Enable CORS for the local GUI only. This server can spawn processes, run
// package installs and delete worktrees, so a wildcard origin would let any
// web page the developer has open drive it cross-origin.
app.use(
  '/api/*',
  cors({
    credentials: true,
    origin: (origin, c) => {
      // No Origin header → same-origin or a non-browser client (CLI/desktop).
      if (!origin) return origin;
      if (c.req.path.startsWith('/api/workrooms/')) {
        return hasExactDashboardOrigin(origin, c.req.url) ? origin : null;
      }
      try {
        const { hostname } = new URL(origin);
        const isLocal =
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          hostname === '[::1]';
        return isLocal ? origin : null;
      } catch {
        return null;
      }
    },
  }),
);

// --- host guard: DNS rebinding protection ---
function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // Internal Hono programmatic invocations / test requests
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0]?.toLowerCase() ?? '';
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

app.use('*', async (c, next) => {
  const host = c.req.header('host');
  if (!isAllowedHost(host)) {
    return c.text('Forbidden: invalid Host header', 403);
  }
  await next();
});

// Work counters for the performance rule checks in perf/. Off unless
// CONTEXTSPACE_PERF_COUNTERS=1, so normal runs register nothing here.
if (installPerfCounters()) {
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/perf/')) return next();
    await countRequest(c.req.method, c.req.path, c.req.raw.signal, () => next());
  });
  app.get('/api/perf/counters', (c) => {
    const snapshot = snapshotPerfCounters();
    if (c.req.query('reset') === '1') resetPerfCounters();
    return c.json(snapshot);
  });
}

// Enforce trusted local origin on all mutating HTTP methods across /api/* to defend against
// cross-site request forgery and browser form posts from untrusted web pages.
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite === 'cross-site') {
      return c.json({ error: 'Forbidden cross-site request.' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin && !hasTrustedLocalOrigin(origin)) {
      return c.json({ error: 'Forbidden cross-origin request.' }, 403);
    }
    const referer = c.req.header('referer');
    if (referer && !hasTrustedLocalOrigin(referer)) {
      return c.json({ error: 'Forbidden cross-origin referer.' }, 403);
    }
  }
  await next();
});

// Archived workspaces keep a readable record. Routes that change repositories
// or start processes refuse them here, before any handler runs; the core
// operations refuse them too, so CLI and MCP callers get the same answer.
const ARCHIVE_REFUSED_ACTIONS = new Set([
  'launch', 'terminal', 'stream', 'resume', 'sync', 'commit', 'push', 'finish', 'isolate', 'repo',
  'verify', 'migrate', 'update-spec', 'domain-packs', 'services', 'orchestrators', 'changes',
]);

/** The workspace action a mutating request targets, when archive must refuse it. */
export function archiveRefusedAction(method: string, requestPath: string): { id: string; action: string } | null {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return null;
  const segments = requestPath.split('/');
  // ['', 'api', 'workspace', ':id', ':action', ...rest]
  if (segments[1] !== 'api' || segments[2] !== 'workspace' || segments.length < 5) return null;
  const action = segments[4] ?? '';
  if (!ARCHIVE_REFUSED_ACTIONS.has(action)) return null;
  // Stopping is how an archived workspace's leftovers are cleaned up.
  if ((action === 'services' || action === 'orchestrators') && segments.slice(5).includes('stop')) return null;
  let id: string;
  try {
    id = decodeURIComponent(segments[3] ?? '');
  } catch {
    return null;
  }
  return id ? { id, action } : null;
}

app.use('/api/workspace/*', async (c, next) => {
  const target = archiveRefusedAction(c.req.method, c.req.path);
  if (target) {
    try {
      const config = await loadConfig();
      const feature = await loadFeatureConfig(resolveWorkspacePath(config.workspacesDir, target.id));
      assertWorkspaceActive(feature, operationLabel(target.action));
    } catch (error) {
      if (error instanceof ArchivedWorkspaceError) return errorResponse(c, error);
      // Anything else (unknown workspace, bad path) is the handler's to report.
    }
  }
  await next();
});

function operationLabel(action: string): string {
  switch (action) {
    case 'launch': case 'terminal': case 'stream': case 'resume': return 'start assistant sessions';
    case 'services': case 'orchestrators': return 'start services';
    case 'isolate': return 'prepare repositories for editing';
    case 'repo': return 'add repositories';
    case 'changes': return 'change files';
    case 'verify': return 'run verification';
    default: return action.replace(/-/g, ' ');
  }
}

// ─── API Endpoints ────────────────────────────────────────────────────────

// Status checks may execute a trusted local CLI from PATH. Keep that work
// behind a non-simple, same-machine POST so a remote page cannot trigger it
// with an image, link, or cross-origin fetch. These routes intentionally sit
// after the API CORS middleware so the separate Vite dev origin can read them.
app.get('/api/adapters/status', (c) => {
  return c.json({ error: 'Use the same-origin POST status endpoint.' }, 405);
});

app.post('/api/adapters/status', (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }
  return c.json(ProviderRegistry.getAllStatus());
});

app.post('/api/adapters/status/refresh', async (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }

  const body = await c.req.json().catch(() => null) as { providerId?: unknown } | null;
  const providerId = typeof body?.providerId === 'string' ? body.providerId : '';
  if (!['claude-cli', 'codex-cli', 'claude-sdk', 'codex-sdk'].includes(providerId)) {
    return c.json({ error: 'Only Claude Code and Codex status can be refreshed.' }, 400);
  }
  return c.json(ProviderRegistry.getAllStatus({ refreshProviderId: providerId }));
});

app.post('/api/chat/upload-attachment', bodyLimit({ maxSize: 28 * 1024 * 1024, onError: c => c.json({ error: 'Image attachment exceeds the 20MB limit.' }, 413) }), async (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }

  try {
    const body = await c.req.json().catch(() => null) as {
      dataUrl?: unknown;
      filename?: unknown;
      workspacePath?: unknown;
    } | null;

    if (!body || typeof body.dataUrl !== 'string') {
      return c.json({ error: 'A valid image dataUrl is required.' }, 400);
    }
    const { buffer, extension } = decodeImageAttachment(body.dataUrl);
    const imageId = crypto.randomUUID();
    const config = await loadConfig();
    const workspaceDir = typeof body.workspacePath === 'string'
      ? await resolveExactLaunchWorkspace(config.workspacesDir, body.workspacePath)
      : null;

    const targetDir = workspaceDir
      ? path.join(workspaceDir, '.nexusflow', 'attachments')
      : path.join(getConfigDir(), 'attachments');

    await fs.mkdir(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, `${imageId}.${extension}`);
    await fs.writeFile(targetFile, buffer);

    return c.json({
      id: imageId,
      filename: typeof body.filename === 'string' ? body.filename : `image-${imageId}.${extension}`,
      path: targetFile,
      size: buffer.length,
    });
  } catch (error) {
    if (error instanceof InvalidImageAttachment) return c.json({ error: error.message }, error.status === 413 ? 413 : 400);
    return errorResponse(c, error);
  }
});

app.get('/api/chat/thread/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');
  if (!workspaceId) {
    return c.json({ error: 'workspaceId is required' }, 400);
  }
  try {
    const thread = loadChatThread(workspaceId);
    const config = await loadConfig().catch(() => null);
    let isBusy = false;
    if (config) {
      try {
        const workspacePath = resolveWorkspacePath(config.workspacesDir, workspaceId);
        isBusy = defaultTurnSessionManager.hasActiveTurn(workspacePath);
      } catch {
        // Workspace not found on disk or invalid
      }
    }
    return c.json({ thread, isBusy });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/chat/thread/:workspaceId', async (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }
  const workspaceId = c.req.param('workspaceId');
  if (!workspaceId) {
    return c.json({ error: 'workspaceId is required' }, 400);
  }
  try {
    const body = await c.req.json().catch(() => null) as any;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Valid chat thread payload is required.' }, 400);
    }
    saveChatThread({
      workspaceId,
      providerId: typeof body.providerId === 'string' ? body.providerId : null,
      sessions: typeof body.sessions === 'object' && body.sessions !== null ? body.sessions : {},
      profilesByProvider: typeof body.profilesByProvider === 'object' && body.profilesByProvider !== null ? body.profilesByProvider : {},
      modelsByProvider: typeof body.modelsByProvider === 'object' && body.modelsByProvider !== null ? body.modelsByProvider : {},
      effortsByProvider: typeof body.effortsByProvider === 'object' && body.effortsByProvider !== null ? body.effortsByProvider : {},
      messages: Array.isArray(body.messages) ? body.messages : [],
    });
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete('/api/chat/thread/:workspaceId', async (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }
  const workspaceId = c.req.param('workspaceId');
  if (!workspaceId) {
    return c.json({ error: 'workspaceId is required' }, 400);
  }
  try {
    clearChatThread(workspaceId);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.route('/api', dataRoutes(async (id) => {
  const config = await loadConfig();
  const workspacePath = await resolveExactWorkspaceById(config.workspacesDir, id);
  if (!workspacePath) throw new Error('Workspace unavailable.');
  return workspacePath;
}));

// 1. Get current configuration
app.get('/api/config', async (c) => {
  try {
    const configPath = path.join(getConfigDir(), 'config.json');
    let exists = false;
    try {
      await fs.access(configPath);
      exists = true;
    } catch {}

    const config = await loadConfig();
    const defaults = getDefaultConfig();
    // Setup shows examples and suggestions for the machine the server runs on,
    // not the browser's platform.
    return c.json({
      config,
      exists,
      platform: process.platform,
      suggested: { devDir: defaults.devDir, workspacesDir: defaults.workspacesDir },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

const configPathsInput = z.object({ devDir: z.string().max(4096).optional(), workspacesDir: z.string().max(4096).optional() });
const countRepos = async (devDir: string) => (await scanForRepos(devDir, (await loadConfig({ quiet: true })).scanDepth)).length;

// Check setup folders before saving so the GUI can explain a bad path inline.
app.post('/api/config/validate', async (c) => {
  const parsed = configPathsInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid folder payload' }, 400);
  return c.json(await checkConfigPaths(parsed.data, { countRepos }));
});

// Get all registered storage adapters
app.get('/api/adapters', async (c) => {
  try {
    const adapters = listStorageProviders();
    return c.json({ adapters });
  } catch (error) {
    return errorResponse(c, error);
  }
});



// 2. Save configuration
app.post('/api/config', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    // `createWorkspacesDir` is a one-off instruction, never a stored setting.
    const { createWorkspacesDir, ...patch } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    for (const key of ['devDir', 'workspacesDir'] as const) {
      if (typeof patch[key] === 'string') patch[key] = expandHome(patch[key]);
    }
    const parsed = configPatchSchema.safeParse(body === null ? null : patch);
    if (!parsed.success) {
      return c.json({ error: 'Invalid config payload', issues: parsed.error.flatten() }, 400);
    }
    const current = await loadConfig();
    const next = { ...current, ...parsed.data };
    // Check a folder only when it changes: saving another setting must not fail
    // because a previously saved folder has since gone away.
    const changed = {
      ...(parsed.data.devDir !== undefined && parsed.data.devDir !== current.devDir ? { devDir: next.devDir } : {}),
      ...(parsed.data.workspacesDir !== undefined && parsed.data.workspacesDir !== current.workspacesDir ? { workspacesDir: next.workspacesDir } : {}),
    };
    if (Object.keys(changed).length) {
      const pair = { devDir: next.devDir, workspacesDir: 'workspacesDir' in changed ? next.workspacesDir : undefined };
      let report = await checkConfigPaths(pair);
      if (createWorkspacesDir === true && report.workspacesDir?.status === 'missing' && report.workspacesDir.canCreate) {
        await fs.mkdir(report.workspacesDir.path, { recursive: true });
        report = await checkConfigPaths(pair);
      }
      const failed = (['devDir', 'workspacesDir'] as const).filter((key) => key in changed && report[key] && report[key]!.status !== 'ok');
      if (failed.length) {
        return c.json({ error: 'Check the highlighted folders.', fields: report }, 422);
      }
      if (report.devDir) next.devDir = report.devDir.path;
      if (report.workspacesDir) next.workspacesDir = report.workspacesDir.path;
    }
    await saveConfig(next);
    return c.json({ success: true, config: next });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3. Scan development directory for repositories
app.get('/api/repos', async (c) => {
  try {
    const config = await loadConfig();
    const repos = await scanForRepos(config.devDir, config.scanDepth);
    return c.json(repos);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3a. List local and origin branches of a repository (for existing-branch selection)
app.get('/api/repos/branches', async (c) => {
  try {
    const repoPath = c.req.query('path');
    if (!repoPath) {
      return c.json({ error: 'Missing "path" query parameter' }, 400);
    }
    const config = await loadConfig();
    // Only repos under devDir are offered by the scanner; refuse anything else.
    const resolved = assertWithin(config.devDir, repoPath);
    const branches = await listBranches(resolved);
    return c.json(branches);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3a.1. Base repository freshness inspection
app.get('/api/repos/freshness', async (c) => {
  try {
    const repoPath = c.req.query('path');
    if (!repoPath) {
      return c.json({ error: 'Missing "path" query parameter' }, 400);
    }
    const branch = c.req.query('branch') || undefined;
    const fetchParam = c.req.query('fetch');
    const config = await loadConfig();
    const resolved = assertWithin(config.devDir, repoPath);
    const freshness = await checkRepoFreshness(resolved, branch, {
      fetch: fetchParam !== 'false' && fetchParam !== '0',
    });
    return c.json(freshness);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/repos/freshness', async (c) => {
  try {
    const body = await c.req.json() as {
      repos?: Array<{ path: string; branch?: string }>;
      fetch?: boolean;
    };
    if (!body.repos || !Array.isArray(body.repos)) {
      return c.json({ error: 'Missing "repos" array in request body' }, 400);
    }
    const config = await loadConfig();
    const validatedRepos = body.repos.map((r) => ({
      path: assertWithin(config.devDir, r.path),
      branch: r.branch,
    }));
    const results = await checkReposFreshness(validatedRepos, {
      fetch: body.fetch !== false,
    });
    return c.json(results);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3a.2. Fast-forward base repository branch to remote tracking branch
app.post('/api/repos/pull', async (c) => {
  try {
    const body = await c.req.json() as {
      path?: string;
      branch?: string;
      repos?: Array<{ path: string; branch?: string }>;
    };
    const config = await loadConfig();
    let reposToUpdate: Array<{ path: string; branch?: string }> = [];
    if (body.repos && Array.isArray(body.repos)) {
      reposToUpdate = body.repos.map((r) => ({
        path: assertWithin(config.devDir, r.path),
        branch: r.branch,
      }));
    } else if (body.path) {
      reposToUpdate = [
        {
          path: assertWithin(config.devDir, body.path),
          branch: body.branch,
        },
      ];
    } else {
      return c.json({ error: 'Missing "path" or "repos" in request body' }, 400);
    }

    const results = await fastForwardRepos(reposToUpdate);
    const allSuccessful = results.every((r) => r.success);
    return c.json({
      success: allSuccessful,
      results,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3b. Scaffold a brand-new local git repository in devDir
app.post('/api/repos/new', async (c) => {
  try {
    const body = await c.req.json() as { name?: string };
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Missing "name" in request body' }, 400);
    }
    const config = await loadConfig();
    const repo = await createNewRepo(config.devDir, body.name);
    return c.json({ success: true, repo });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 3c. Project registry — named groups of source repos that features start from.
app.get('/api/projects', async (c) => {
  try {
    return c.json(await loadProjects({ quiet: true }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/projects', async (c) => {
  try {
    const body = await c.req.json() as { name?: string; repos?: string[]; description?: string };
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Missing "name" in request body' }, 400);
    }
    if (!Array.isArray(body.repos) || body.repos.length === 0) {
      return c.json({ error: 'Missing "repos" in request body' }, 400);
    }
    const config = await loadConfig();
    // Only repos under devDir are offered by the scanner; refuse anything else.
    const repos = body.repos.map((r) => assertWithin(config.devDir, r));
    const project = await createProject(body.name, repos, body.description);
    return c.json(project, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put('/api/projects/:id', async (c) => {
  try {
    const body = await c.req.json() as { name?: string; repos?: string[]; description?: string };
    let repoPaths: string[] | undefined;
    if (body.repos !== undefined) {
      if (!Array.isArray(body.repos) || body.repos.length === 0) {
        return c.json({ error: '"repos" must be a non-empty array' }, 400);
      }
      const config = await loadConfig();
      repoPaths = body.repos.map((r) => assertWithin(config.devDir, r));
    }
    const project = await updateProject(c.req.param('id'), {
      name: body.name,
      description: body.description,
      repoPaths,
    });
    return c.json(project);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No project')) {
      return c.json({ error: error.message }, 404);
    }
    return errorResponse(c, error);
  }
});

// Registry-only delete — never touches repos or workspaces on disk.
app.delete('/api/projects/:id', async (c) => {
  try {
    const removed = await removeProject(c.req.param('id'));
    if (!removed) {
      return c.json({ error: `No project with id "${c.req.param('id')}"` }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 4. List existing workspaces (ordered by newest creation date first)
app.get('/api/workspaces', async (c) => {
  try {
    const config = await loadConfig();
    const workspaces = await listWorkspaces(config.workspacesDir);
    workspaces.sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
    return c.json(workspaces);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Severity ranking for picking the worst per-repo sync outcome in a workspace.
const SYNC_SEVERITY: Record<SyncStatus, number> = {
  conflict: 4,
  'stash-conflict': 3,
  error: 2,
  rebased: 1,
  'up-to-date': 0,
};

/** Returns the most severe recorded sync status across a workspace's repos. */
function worstSyncStatus(states: RepoSyncState[]): SyncStatus | 'unknown' {
  let worst: SyncStatus | 'unknown' = 'unknown';
  let worstSeverity = -1;
  for (const s of states) {
    if (!s.lastSyncStatus) continue;
    const severity = SYNC_SEVERITY[s.lastSyncStatus];
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worst = s.lastSyncStatus;
    }
  }
  return worst;
}

// A paged status scan keeps one stable catalog and PM2 snapshot across requests.
// The small bounded cache avoids rescanning every manifest for each page.
// Many workspaces use the same repository in place, so one scan also runs
// `git status` once per distinct repository and shares it across its pages;
// the next scan (a new snapshot) reads fresh status.
const STATUS_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
type RepoStatusMemo = Map<string, ReturnType<typeof getRepoStatus>>;
const statusSnapshots = new Map<string, {
  workspacesDir: string;
  workspaces: Feature[];
  pm2List: Promise<any[] | null>;
  repoStatus: RepoStatusMemo;
  expiresAt: number;
}>();

function memoizedRepoStatus(memo: RepoStatusMemo, repoPath: string): ReturnType<typeof getRepoStatus> {
  const key = path.resolve(repoPath);
  let status = memo.get(key);
  if (!status) {
    status = getRepoStatus(key, { readOnly: true });
    memo.set(key, status);
  }
  return status;
}

// 4b. Aggregate at-a-glance status for every workspace (for the listing overview).
// Git status is read-only; never fetch/rebase here.
app.get('/api/workspaces/status', async (c) => {
  try {
    const config = await loadConfig();
    const offsetParam = c.req.query('offset');
    const limitParam = c.req.query('limit');
    const snapshotParam = c.req.query('snapshot');
    const paged = offsetParam !== undefined || limitParam !== undefined || snapshotParam !== undefined;
    if (paged && (!/^(0|[1-9]\d*)$/.test(offsetParam ?? '') || !/^[1-9]\d*$/.test(limitParam ?? ''))) {
      return c.json({ error: 'offset and limit must be non-negative and positive integers' }, 400);
    }
    const offset = Number(offsetParam ?? 0);
    const limit = Number(limitParam ?? 0);
    if (paged && (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit > 24)) {
      return c.json({ error: 'limit must be at most 24' }, 400);
    }
    if (paged && offset > 0 && !snapshotParam) {
      return c.json({ error: 'snapshot is required after the first page' }, 400);
    }
    const now = Date.now();
    for (const [key, snapshot] of statusSnapshots) {
      if (snapshot.expiresAt < now) statusSnapshots.delete(key);
    }
    let snapshotId = snapshotParam;
    let snapshot = snapshotParam ? statusSnapshots.get(snapshotParam) : undefined;
    if (snapshotParam && (!snapshot || snapshot.workspacesDir !== config.workspacesDir)) {
      return c.json({ error: 'Status snapshot expired; restart from the first page' }, 410);
    }
    if (paged && !snapshot) {
      const workspaces = await listWorkspaces(config.workspacesDir);
      workspaces.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      snapshot = {
        workspacesDir: config.workspacesDir,
        workspaces,
        pm2List: workspaces.length ? readPm2List() : Promise.resolve([]),
        repoStatus: new Map(),
        expiresAt: now + STATUS_SNAPSHOT_TTL_MS,
      };
      snapshotId = randomUUID();
      statusSnapshots.set(snapshotId, snapshot);
      while (statusSnapshots.size > 16) statusSnapshots.delete(statusSnapshots.keys().next().value!);
    }
    const workspaces = snapshot?.workspaces ?? await listWorkspaces(config.workspacesDir);
    const repoStatusMemo: RepoStatusMemo = snapshot?.repoStatus ?? new Map();
    const selected = paged ? workspaces.slice(offset, offset + limit) : workspaces;

    // Fetch the PM2 process list once for the whole overview instead of
    // spawning `npx pm2 jlist` per workspace (slow, especially on Windows).
    const pm2List = selected.length ? await (snapshot?.pm2List ?? readPm2List()) : [];

    const entries = await Promise.all(
      selected.map(async (ws) => {
        const workspacePath =
          ws.workspacePath || path.join(config.workspacesDir, ws.branchName);
        const status: WorkspaceStatus = {
          id: ws.id,
          branchName: ws.branchName,
          changedFiles: 0,
          dirtyRepos: 0,
          runningServices: 0,
          syncStatus: 'unknown' as SyncStatus | 'unknown',
          pendingValidation: false,
          activeAssistants: [],
        };

        // An archived workspace has no worktrees of its own; its references'
        // changes belong to the user's checkouts, not to this workspace.
        if (ws.archivedAt) return status;

        try {
          // Uncommitted changes across the workspace's repos: worktrees inside
          // the workspace dir, or the source repos themselves for in-place.
          for (const repoPath of ws.repos) {
            const worktreePath = resolveFeatureRepoPath(ws, workspacePath, repoPath);
            const repoStatus = await memoizedRepoStatus(repoStatusMemo, worktreePath);
            if (repoStatus.hasChanges) {
              status.dirtyRepos += 1;
              status.changedFiles += repoStatus.changedFiles.length;
            }
          }

          // Running services (cached running-state, PM2-verified — same source as
          // the Services tab; only workspaces that ever started services touch PM2).
          const runningState = await loadRunningState(workspacePath, pm2List);
          status.runningServices =
            (runningState?.services?.length ?? 0) + (runningState?.orchestrators?.length ?? 0);

          // Sync state: worst-case classification + any repo pending validation.
          const wsState = await loadWorkspaceState(workspacePath);
          const repoStates = Object.values(wsState.repos);
          status.syncStatus = worstSyncStatus(repoStates);
          status.pendingValidation = repoStates.some((r) => r.pendingValidation);

          // Active AI assistant sessions
          status.activeAssistants = await findActiveAssistants(workspacePath, ws.repos);
        } catch {
          // Leave defaults on any per-workspace failure so one bad repo doesn't
          // fail the whole response.
        }

        return status;
      })
    );

    // Keyed by branchName to match how the GUI looks up a workspace.
    const byWorkspace: Record<string, (typeof entries)[number]> = {};
    for (const entry of entries) byWorkspace[entry.branchName] = entry;
    return c.json(paged ? {
      statuses: byWorkspace,
      total: workspaces.length,
      nextOffset: offset + selected.length < workspaces.length ? offset + selected.length : null,
      snapshot: snapshotId,
    } : byWorkspace);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 5. Detect available AI assistants
app.get('/api/ai-detect', async (c) => {
  try {
    const assistants = await detectAIAssistants();
    return c.json(assistants);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 6. Detect available editors
app.get('/api/editor-detect', async (c) => {
  try {
    const editors = await detectEditors();
    return c.json(editors);
  } catch (error) {
    return errorResponse(c, error);
  }
});



interface JobStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
}

interface CreationJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  error?: string;
  steps: JobStep[];
  workspacePath?: string;
  feature?: Feature;
  listeners: Set<(event: { type: string; data: any }) => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const creationJobs = new Map<string, CreationJob>();

// Keep a finished job around briefly so a late SSE reconnect can still read its
// final state, then drop it so the map doesn't grow unbounded.
const FINISHED_JOB_TTL_MS = 5 * 60 * 1000;

function scheduleJobCleanup(jobId: string) {
  const job = creationJobs.get(jobId);
  if (!job || job.cleanupTimer) return;
  job.cleanupTimer = setTimeout(() => creationJobs.delete(jobId), FINISHED_JOB_TTL_MS);
  job.cleanupTimer.unref?.();
}

function updateJobStep(
  jobId: string,
  stepId: string,
  status: 'running' | 'completed' | 'failed',
  message: string,
  extraData?: any
) {
  const job = creationJobs.get(jobId);
  if (!job) return;

  const step = job.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = status;
    step.message = message;
  }

  const isLastStep = job.steps[job.steps.length - 1]?.id === stepId;
  if (isLastStep && status === 'completed') {
    job.status = 'completed';
    job.progress = 100;
  } else if (status === 'failed') {
    job.status = 'failed';
    job.error = message;
  } else {
    const completedCount = job.steps.filter((s) => s.status === 'completed').length;
    const runningCount = job.steps.filter((s) => s.status === 'running').length;
    job.progress = Math.round(((completedCount + runningCount * 0.5) / job.steps.length) * 100);
  }

  const eventPayload = {
    type: 'progress',
    data: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      steps: job.steps,
      workspacePath: job.workspacePath,
      feature: job.feature,
      ...extraData,
    },
  };

  for (const listener of job.listeners) {
    listener(eventPayload);
  }

  if (job.status === 'completed' || job.status === 'failed') {
    scheduleJobCleanup(jobId);
  }
}

async function runCreationJob(jobId: string, body: any, config: any) {
  try {
    const inPlace = body.mode === 'in-place';
    // Workspace id doubles as the directory name: the branch for worktree
    // mode, the (slugified) workspace name for in-place mode.
    const workspaceId = inPlace ? jobId : body.branchName;
    const workspacePath = resolveWorkspacePath(config.workspacesDir, workspaceId);
    const job = creationJobs.get(jobId);
    if (job) {
      job.workspacePath = workspacePath;
    }

    // Record which repos ride an existing branch instead of the feature branch.
    const repoBranches: Record<string, string> = {};
    for (const r of body.repos as RepoSelection[]) {
      if (r.existingBranch) {
        repoBranches[r.name] = r.existingBranch;
      }
    }

    const feature: Feature = {
      id: workspaceId,
      mode: inPlace ? 'in-place' : 'worktree',
      flowType: body.flowType,
      workType: body.workType,
      projectId: body.projectId,
      name: body.name?.trim() || undefined,
      // In-place features never create a branch; keeping branchName populated
      // (= id) avoids breaking every consumer of the non-optional field.
      branchName: inPlace ? workspaceId : body.branchName,
      description: body.description ?? '',
      repos: inPlace
        ? body.repos.map((r: any) => r.path)
        : body.repos.map((r: any) => path.join(workspacePath, r.name)),
      originalRepos: body.repos.map((r: any) => r.path),
      repoBranches: !inPlace && Object.keys(repoBranches).length > 0 ? repoBranches : undefined,
      assistants: body.assistants,
      workspacePath,
      createdAt: new Date().toISOString(),
      resumption: body.resumption,
      teamworkInstructions: body.teamworkInstructions,
      organizationId: body.organizationId,
      domainPacks: Array.isArray(body.domainPacks) && body.domainPacks.length > 0
        ? body.domainPacks
        : matchDomainPacks(body.description || '', (body.repos || []).map((r: any) => r.name)).map((p) => p.id),
    };
    if (job) {
      job.feature = feature;
    }

    // Step 1: Materialize the workspace (worktrees, or just the lightweight
    // dir). One stable step id for both modes — only the wording differs.
    updateJobStep(jobId, 'workspace', 'running', inPlace ? 'Registering workspace...' : 'Creating git worktrees...');
    await createWorkspace(feature, body.repos, undefined, {
      autoUpdateBase: body.autoUpdateBase === true,
    });

    if (Array.isArray(body.enabledSkills) || Array.isArray(body.enabledAgents) || Array.isArray(body.enabledCategories)) {
      await saveWorkspaceSkillsConfig(workspacePath, {
        enabledSkills: Array.isArray(body.enabledSkills) ? body.enabledSkills : [],
        enabledAgents: Array.isArray(body.enabledAgents) ? body.enabledAgents : [],
        enabledCategories: Array.isArray(body.enabledCategories) ? body.enabledCategories : [],
      });
    }

    updateJobStep(
      jobId,
      'workspace',
      'completed',
      inPlace ? 'Workspace registered — working in-place in the source repos.' : 'Git worktrees created successfully.',
    );

    // Step 2: Analyze repos — against the worktrees, or the source repos in-place.
    updateJobStep(jobId, 'analysis', 'running', 'Analyzing projects and dependencies...');
    const workspaceRepos = inPlace
      ? body.repos
      : body.repos.map((repo: any) => ({
          ...repo,
          path: path.join(workspacePath, repo.name),
        }));
    const analysis = await analyzeAllRepos(workspaceRepos);
    updateJobStep(jobId, 'analysis', 'completed', 'Project analysis complete.');

    // Step 3: Generate AI context files
    updateJobStep(jobId, 'context', 'running', 'Generating AI context files...');
    const ctx: WorkspaceContext = {
      feature,
      repos: workspaceRepos,
      analysis,
    };
    await generateContextFiles(ctx, body.assistants, workspacePath);
    updateJobStep(jobId, 'context', 'completed', 'AI context files generated.');

    // XML context packing removed.

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const job = creationJobs.get(jobId);
    if (job) {
      const runningStep = job.steps.find((s) => s.status === 'running');
      const failedStepId = runningStep ? runningStep.id : 'workspace';
      updateJobStep(jobId, failedStepId, 'failed', msg);
    }
  }
}

// 7. Create workspace
app.post('/api/workspace', async (c) => {
  try {
    const body = await c.req.json() as {
      mode?: 'worktree' | 'in-place';
      projectId?: string;
      /** Human-readable workspace name; required for in-place mode. */
      name?: string;
      branchName?: string;
      description?: string;
      repos: RepoSelection[];
      assistants: any[];
      enabledSkills?: string[];
      enabledAgents?: string[];
      enabledCategories?: string[];
      flowType?: 'quick' | 'feature' | 'epic';
      workType?: Feature['workType'];
      domainPacks?: string[];
      organizationId?: string;
      teamworkInstructions?: string;
      autoUpdateBase?: boolean;
      resumption?: {
        testCommand?: string;
        mockCommand?: string;
        startCommand?: string;
      };
    };

    if (body.workType !== undefined && !['bug', 'feature', 'performance', 'refactor', 'rewrite'].includes(body.workType)) {
      return c.json({ error: 'Choose a valid work type.' }, 400);
    }
    if (body.flowType !== undefined && !['quick', 'feature', 'epic'].includes(body.flowType)) {
      return c.json({ error: 'flowType must be quick, feature, or epic.' }, 400);
    }
    const inPlace = body.mode === 'in-place';
    if (inPlace && !body.name?.trim()) {
      return c.json({ error: 'In-place workspaces need a "name"' }, 400);
    }
    if (!inPlace && !body.branchName) {
      return c.json({ error: 'Missing "branchName" in request body' }, 400);
    }

    const config = await loadConfig();
    const devDir = config.devDir || path.join(os.homedir(), 'dev');
    // Validate repo names and paths synchronously before starting the job.
    for (const r of body.repos || []) {
      if (inPlace) {
        if (!r.path) {
          return c.json({ error: 'Repository path is required for in-place mode.' }, 400);
        }
        assertWithin(devDir, path.resolve(r.path));
      } else {
        if (r.name && !isValidProjectName(r.name)) {
          return c.json({ error: `Invalid repository name: ${JSON.stringify(r.name)}` }, 400);
        }
        if (r.path) {
          assertWithin(devDir, path.resolve(r.path));
        }
      }
    }
    // The job id doubles as the workspace directory name.
    const jobId = inPlace ? slugifyProjectName(body.name!) : body.branchName!;
    if (!jobId) {
      return c.json({ error: `Workspace name "${body.name}" contains no usable characters` }, 400);
    }

    if (creationJobs.has(jobId)) {
      const existing = creationJobs.get(jobId)!;
      if (existing.status === 'running') {
        return c.json({ success: true, jobId, message: 'Job already running' });
      }
    }

    const steps: JobStep[] = [
      // Stable id 'workspace' in both modes so progress consumers never need
      // to know the mode; only the display name differs.
      { id: 'workspace', name: inPlace ? 'Register Workspace' : 'Create Git Worktrees', status: 'pending', message: 'Waiting...' },
      { id: 'analysis', name: 'Analyze Repositories', status: 'pending', message: 'Waiting...' },
      { id: 'context', name: 'Generate AI Context Files', status: 'pending', message: 'Waiting...' },
    ];
    // XML context packing removed.

    const job: CreationJob = {
      id: jobId,
      status: 'running',
      progress: 0,
      steps,
      listeners: new Set(),
    };
    creationJobs.set(jobId, job);

    // Run the job in background
    runCreationJob(jobId, body, config);

    return c.json({ success: true, jobId });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.5. Create workspace SSE stream
app.get('/api/workspace/create-stream/:jobId', async (c) => {
  const jobId = decodeURIComponent(c.req.param('jobId'));
  const job = creationJobs.get(jobId);
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return streamSSE(c, async (stream) => {
    // Send initial state
    await stream.writeSSE({
      event: 'progress',
      data: JSON.stringify({
        id: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        steps: job.steps,
        workspacePath: job.workspacePath,
        feature: job.feature,
      }),
    });

    if (job.status === 'completed' || job.status === 'failed') {
      return;
    }

    // Keep the connection open until the job finishes, driven by job events
    // rather than polling.
    await new Promise<void>((resolve) => {
      const listener = async (event: { type: string; data: any }) => {
        try {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
          });
        } catch {
          job.listeners.delete(listener);
          resolve();
          return;
        }
        if (event.data?.status === 'completed' || event.data?.status === 'failed') {
          job.listeners.delete(listener);
          resolve();
        }
      };

      job.listeners.add(listener);

      // Guard against the job finishing between the initial state write and
      // now: the client only saw a 'running' frame, so send the terminal
      // state before closing — silently ending the stream here would leave
      // the client believing the connection dropped mid-run.
      if (job.status === 'completed' || job.status === 'failed') {
        job.listeners.delete(listener);
        stream
          .writeSSE({
            event: 'progress',
            data: JSON.stringify({
              id: job.id,
              status: job.status,
              progress: job.progress,
              error: job.error,
              steps: job.steps,
              workspacePath: job.workspacePath,
              feature: job.feature,
            }),
          })
          .catch(() => {})
          .finally(() => resolve());
      }
    });
  });
});

// 7.6. Delete workspace
app.delete('/api/workspace/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    await deleteWorkspace(workspacePath);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.6a. Archive a workspace: return its worktrees, keep its record.
app.post('/api/workspace/:id/archive', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json().catch(() => ({})) as { park?: unknown; dryRun?: unknown; keepBranches?: unknown; deleteRemoteBranches?: unknown; fetch?: unknown };
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    if (!(await loadFeatureConfig(workspacePath))) return c.json({ error: `Workspace "${id}" not found.` }, 404);
    const report = await archiveWorkspace(workspacePath, {
      park: body.park === true,
      dryRun: body.dryRun === true,
      keepBranches: body.keepBranches === true,
      deleteRemoteBranches: body.deleteRemoteBranches === true,
      // A preview may skip fetching when the caller fetched moments ago; archive itself always fetches.
      fetch: body.dryRun === true && body.fetch === false ? false : undefined,
    });
    if (!report.dryRun && !report.alreadyArchived && !report.ready) return c.json({ ...report, error: report.blockers.join(' ') }, 409);
    if (report.errors.length > 0) return c.json({ ...report, error: report.errors.join(' ') }, 500);
    return c.json(report);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.6b. Restore an archived workspace as active (repositories stay references).
app.post('/api/workspace/:id/unarchive', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    if (!(await loadFeatureConfig(workspacePath))) return c.json({ error: `Workspace "${id}" not found.` }, 404);
    return c.json(await unarchiveWorkspace(workspacePath));
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.7. Add repo to workspace
app.post('/api/workspace/:id/repo', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const { repoPath } = await c.req.json() as { repoPath: string };
    const config = await loadConfig();
    const devDir = config.devDir || path.join(os.homedir(), 'dev');
    assertWithin(devDir, path.resolve(repoPath));
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    await addRepoToWorkspace(workspacePath, repoPath);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.7b. Isolate repo in in-place workspace
app.post('/api/workspace/:id/isolate', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json().catch(() => ({})) as {
      repo?: unknown;
      branchName?: unknown;
      baseBranch?: unknown;
      dryRun?: unknown;
    };
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    if (!repo) {
      return c.json({ error: 'Missing "repo" parameter in request body' }, 400);
    }
    const branchName = typeof body.branchName === 'string' && body.branchName.trim() ? body.branchName.trim() : undefined;
    const baseBranch = typeof body.baseBranch === 'string' && body.baseBranch.trim() ? body.baseBranch.trim() : undefined;

    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    // A preview shows path, branch, base and conflicts before anything is created.
    if (body.dryRun === true) {
      return c.json(await planRepoIsolation(workspacePath, repo, { branchName, baseBranch }));
    }
    const result = await isolateWorkspaceRepo(workspacePath, repo, {
      branchName,
      baseBranch,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 7.8. Suggest workflow strategy based on feature description & selected repos
app.post('/api/workspace/suggest-workflow', async (c) => {
  try {
    const { description, repos } = await c.req.json() as {
      description: string;
      repos: RepoInfo[];
    };

    const suggestion = await suggestWorkflow(description, repos);

    return c.json({
      success: true,
      ...suggestion
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 8. List the closed, server-owned launch catalog.
app.get('/api/workspace-launch-targets', async (c) => {
  try {
    return c.json(await detectWorkspaceLaunchTargets());
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 8a. Open a real NexusFlow workspace in a selected desktop app or editor.
app.post('/api/workspace/:id/launch', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !hasTrustedLocalOrigin(origin)) {
    return c.json({ error: 'Forbidden cross-origin request.' }, 403);
  }

  try {
    const id = decodeURIComponent(c.req.param('id'));
    const { targetId, action = 'new', sessionId } = await c.req.json().catch(() => ({})) as {
      targetId?: unknown;
      action?: unknown;
      sessionId?: unknown;
    };
    if (typeof targetId !== 'string' || !targetId) {
      return c.json({ error: 'A workspace launch target is required.' }, 400);
    }
    if (action !== 'new' && action !== 'resume') {
      return c.json({ error: 'Unknown workspace launch action.' }, 400);
    }
    if (action === 'new' && sessionId !== undefined) {
      return c.json({ error: 'A new workspace launch cannot include a session id.' }, 400);
    }

    const config = await loadConfig();
    const requestedWorkspacePath = resolveWorkspacePath(config.workspacesDir, id);
    let workspacePath: string | null;
    try {
      workspacePath = await resolveExactLaunchWorkspace(config.workspacesDir, requestedWorkspacePath);
    } catch (error) {
      if (error instanceof PathAccessError) throw error;
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }
    if (!workspacePath) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }
    const feature = await loadWorkspaceManifest(workspacePath);
    if (!feature) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    const targets = await detectWorkspaceLaunchTargets();
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) return c.json({ error: 'Unknown workspace launch target.' }, 400);
    if (!target.available) {
      return c.json({ error: target.unavailableReason ?? `${target.name} is unavailable.` }, 409);
    }

    if (action === 'resume') {
      if (targetId !== 'codex-desktop') {
        return c.json({ error: 'This app cannot open an existing coding session.' }, 400);
      }
      if (typeof sessionId !== 'string' || !isValidSessionUuid(sessionId)) {
        return c.json({ error: 'A valid Codex session id is required.' }, 400);
      }
      const ownsSession = await canOpenCodexSessionInWorkspace(
        workspacePath,
        feature.repos,
        sessionId,
      );
      if (!ownsSession) {
        return c.json({ error: 'Codex session not found in this workspace.' }, 404);
      }
      await launchWorkspaceTarget(targetId, workspacePath, { kind: 'resume-session', sessionId });
      return c.json({ success: true, targetId, action, sessionId });
    }

    await launchWorkspaceTarget(targetId, workspacePath, {
      kind: 'new-workspace',
      prompt: buildWorkspaceLaunchPrompt(feature),
    });
    return c.json({ success: true, targetId, action });
  } catch (error) {
    return errorResponse(c, error);
  }
});

registerTerminalRoutes(app, upgradeWebSocket, async (id) => {
  const config = await loadConfig();
  return resolveExactLaunchWorkspace(config.workspacesDir, resolveWorkspacePath(config.workspacesDir, id));
});

// 8b. Launch an external interactive terminal for a workspace or AI session.
app.post('/api/workspace/:id/terminal', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !hasTrustedLocalOrigin(origin)) {
    return c.json({ error: 'Forbidden cross-origin request.' }, 403);
  }

  try {
    const id = decodeURIComponent(c.req.param('id'));
    const { command, assistant, sessionId, title, cwd } = await c.req.json().catch(() => ({})) as {
      command?: unknown;
      assistant?: unknown;
      sessionId?: unknown;
      title?: unknown;
      cwd?: unknown;
    };

    if (assistant !== undefined) {
      if (typeof assistant !== 'string' || !SUPPORTED_ASSISTANTS.has(assistant.trim().toLowerCase())) {
        return c.json({ error: 'Invalid or unsupported assistant parameter.' }, 400);
      }
    }

    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
        return c.json({ error: 'Invalid session ID format.' }, 400);
      }
    }

    if (command !== undefined && (typeof command !== 'string' || !command.trim())) {
      return c.json({ error: 'Command must be a non-empty string.' }, 400);
    }

    if (title !== undefined && typeof title !== 'string') {
      return c.json({ error: 'Title must be a string.' }, 400);
    }

    if (cwd !== undefined && typeof cwd !== 'string') {
      return c.json({ error: 'Cwd must be a string.' }, 400);
    }

    const config = await loadConfig();
    const requestedWorkspacePath = resolveWorkspacePath(config.workspacesDir, id);
    let workspacePath: string | null;
    try {
      workspacePath = await resolveExactLaunchWorkspace(config.workspacesDir, requestedWorkspacePath);
    } catch (error) {
      if (error instanceof PathAccessError) throw error;
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }
    if (!workspacePath) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    await checkGenerationLock(workspacePath, { markDocuments: true });

    let launchPath = workspacePath;
    if (typeof cwd === 'string' && cwd.trim()) {
      try {
        const canonicalWorkspace = await fs.realpath(workspacePath);
        const canonicalCwd = await fs.realpath(path.resolve(workspacePath, cwd.trim()));
        launchPath = assertWithin(canonicalWorkspace, canonicalCwd);
      } catch (error) {
        if (error instanceof PathAccessError) {
          return c.json({ error: 'Launch directory must be within workspace.' }, 400);
        }
        return c.json({ error: 'Launch directory not found or invalid.' }, 400);
      }
    }

    const res = await launchWorkspaceTerminal(launchPath, {
      command: typeof command === 'string' ? command : undefined,
      assistant: typeof assistant === 'string' ? assistant : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      title: typeof title === 'string' ? title : undefined,
    });

    return c.json({ success: true, command: res.command });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 8c. Legacy editor route retained for older GUI clients using recognized
// graphical editors. Interactive terminal editors are intentionally rejected:
// a detached HTTP request cannot safely provide their required TTY.
app.post('/api/open-editor', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !hasTrustedLocalOrigin(origin)) {
    return c.json({ error: 'Forbidden cross-origin request.' }, 403);
  }

  try {
    const body = await c.req.json().catch(() => ({})) as {
      workspacePath?: unknown;
      command?: unknown;
      filePath?: unknown;
    };
    const { workspacePath, command, filePath } = body;
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return c.json({ error: 'Workspace path does not exist' }, 400);
    }
    if (typeof command !== 'string' || !command.trim()) {
      return c.json({ error: 'Forbidden editor command' }, 400);
    }

    const targetId = launchTargetIdForEditorCommand(command);
    if (!ALLOWED_EDITORS.has(command) || !targetId) {
      return c.json({ error: 'Forbidden editor command' }, 400);
    }

    const config = await loadConfig();
    let safeWorkspacePath: string;
    let isDevDir = false;
    try {
      safeWorkspacePath = assertWithin(config.workspacesDir, workspacePath);
    } catch {
      safeWorkspacePath = assertWithin(config.devDir, workspacePath);
      isDevDir = true;
    }

    // Validate this is an existing NexusFlow workspace or source repository, not an arbitrary path.
    try {
      const stats = await fs.stat(safeWorkspacePath);
      if (!stats.isDirectory()) {
        return c.json({ error: 'Workspace path is not a directory' }, 400);
      }
    } catch {
      return c.json({ error: 'Workspace path does not exist' }, 400);
    }

    let exactWorkspacePath: string | null = null;
    if (!isDevDir) {
      exactWorkspacePath = await resolveExactLaunchWorkspace(
        config.workspacesDir,
        safeWorkspacePath,
      );
      if (!exactWorkspacePath) {
        let current = path.dirname(safeWorkspacePath);
        while (current.length >= config.workspacesDir.length) {
          exactWorkspacePath = await resolveExactLaunchWorkspace(config.workspacesDir, current);
          if (exactWorkspacePath) break;
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    } else {
      // Under devDir the target must be a source repository reached without
      // following a link out of devDir; continue with its resolved path.
      exactWorkspacePath = await resolveSourceRepository(config.devDir, safeWorkspacePath);
      if (exactWorkspacePath) safeWorkspacePath = exactWorkspacePath;
    }
    if (!exactWorkspacePath) {
      return c.json({ error: isDevDir ? 'Source repository not found.' : 'Workspace configuration not found.' }, 404);
    }

    let resolvedFilePath: string | undefined;
    if (typeof filePath === 'string' && filePath.trim()) {
      try {
        resolvedFilePath = await resolveRepositoryFileForLaunch(safeWorkspacePath, filePath.trim());
      } catch (error) {
        if (error instanceof RepositoryFileAccessError) {
          return c.json({ error: 'File does not exist or is not a regular file inside the workspace.' }, 400);
        }
        throw error;
      }
    }

    await launchWorkspaceTarget(
      targetId,
      resolvedFilePath ? safeWorkspacePath : exactWorkspacePath,
      { kind: 'new-workspace' },
      process.platform,
      resolvedFilePath,
    );

    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 9. Get status of running services in all/specific workspace
app.get('/api/workspace/:id/services', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    // Detect all services
    const services = await detectAllServices(workspacePath);
    // Detect existing tools
    const tools = await detectOrchestrationTools(workspacePath);
    // Get currently running services from running state
    const runningState = await loadRunningState(workspacePath);

    return c.json({
      services,
      orchestrationTools: tools,
      runningState: runningState?.services || [],
      runningOrchestrators: runningState?.orchestrators || [],
      failures: runningState?.failures || [],
      // One suggestion per repository that declares nothing, even when others do.
      suggestions: suggestProcfiles(services.filter((service) => !service.declared)),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

function getWorkspaceLogDir(workspacePath: string): string {
  const primary = path.join(workspacePath, PRIMARY_LOGS_DIR);
  const legacy = path.join(workspacePath, LEGACY_LOGS_DIR);
  if (existsSync(primary)) return primary;
  if (existsSync(legacy)) return legacy;
  return primary;
}

// 10. Start services in workspace. Configs are re-detected server-side —
// the client only says "start", never what to execute. Only services the
// repositories declare start together; guessed ones start one at a time.
app.post('/api/workspace/:id/services/start', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const logDir = getWorkspaceLogDir(workspacePath);

    const declared = (await detectAllServices(workspacePath)).filter((service) => service.declared);
    if (declared.length === 0) {
      return c.json({ error: 'No declared services. Add a Procfile.dev with one `name: command` line per process, or start a guessed service on its own.' }, 409);
    }
    const results = await startServices(declared, workspacePath, logDir);
    return c.json({ success: results.every((result) => result.status === 'running'), results });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 11. Stop services in workspace
app.post('/api/workspace/:id/services/stop', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    await stopServices(workspacePath);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 11b. Per-service start / stop / restart. The service config is re-detected
// by name server-side; the client never supplies a command.
app.post('/api/workspace/:id/services/:serviceName/:action{start|stop|restart}', async (c) => {
  try {
    const id = c.req.param('id');
    const serviceName = decodeURIComponent(c.req.param('serviceName'));
    const action = c.req.param('action') as 'start' | 'stop' | 'restart';
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const logDir = getWorkspaceLogDir(workspacePath);

    if (action === 'stop') {
      const stopped = await stopService(workspacePath, serviceName);
      return c.json({ success: true, stopped });
    }

    const services = await detectAllServices(workspacePath);
    const service = services.find((s) => s.name === serviceName);
    if (!service) {
      return c.json({ error: `Unknown service "${serviceName}" in this workspace.` }, 404);
    }
    const result = action === 'restart'
      ? await restartService(service, workspacePath, logDir)
      : await startService(service, workspacePath, logDir);
    return c.json({ success: result.status === 'running', service: result, reason: result.reason });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/** Resolve + contain a service log path; names may contain '/' (repo/sub). */
function resolveServiceLogFile(workspacePath: string, serviceName: string): string {
  const logDir = getWorkspaceLogDir(workspacePath);
  return assertWithin(logDir, path.join(logDir, `${serviceName}.log`));
}

// 12. Get service logs (backfill). Returns the trailing 50KB and the byte
// offset the read ended at, so the SSE stream can resume exactly there.
app.get('/api/workspace/:id/services/logs/:serviceName', async (c) => {
  try {
    const id = c.req.param('id');
    const serviceName = decodeURIComponent(c.req.param('serviceName'));
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const logFile = resolveServiceLogFile(workspacePath, serviceName);

    let content = '';
    let size = 0;
    try {
      const fd = await fs.open(logFile, 'r');
      try {
        const stats = await fd.stat();
        size = stats.size;
        const start = Math.max(0, size - 50000);
        const buffer = Buffer.alloc(size - start);
        await fd.read(buffer, 0, buffer.length, start);
        content = buffer.toString('utf-8');
      } finally {
        await fd.close();
      }
    } catch {
      content = 'No logs available yet.';
    }

    return c.json({ logs: content, size });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 12b. Live log stream (SSE): tails the log file from ?offset onward,
// emitting 'log' events with JSON-encoded chunks (raw SSE frames would mangle
// embedded newlines). A 15s ping keeps idle streams alive.
app.get('/api/workspace/:id/services/logs/:serviceName/stream', async (c) => {
  // Resolve + validate the log path BEFORE opening the stream so a bad name
  // (e.g. a traversal attempt) returns a clean error, mirroring the backfill
  // route, rather than a raw 500 from an uncaught throw.
  let logFile: string;
  let startOffset: number | undefined;
  try {
    const id = c.req.param('id');
    const serviceName = decodeURIComponent(c.req.param('serviceName'));
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    logFile = resolveServiceLogFile(workspacePath, serviceName);
    const offsetParam = Number.parseInt(c.req.query('offset') ?? '', 10);
    startOffset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : undefined;
  } catch (error) {
    return errorResponse(c, error);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'init', data: JSON.stringify({ offset: startOffset ?? null }) });

    await new Promise<void>((resolve) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        tail.stop();
        clearInterval(heartbeat);
        resolve();
      };

      const tail = tailLogFile(
        logFile,
        (chunk) => {
          stream.writeSSE({ event: 'log', data: JSON.stringify({ chunk }) }).catch(cleanup);
        },
        { startOffset },
      );

      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '{}' }).catch(cleanup);
      }, 15_000);

      stream.onAbort(cleanup);
    });
  });
});

// 12c. Orchestration tools: start/stop by detection id only — the tool is
// re-detected server-side and the client can never supply a command.
app.post('/api/workspace/:id/orchestrators/:action{start|stop}', async (c) => {
  try {
    const id = c.req.param('id');
    const action = c.req.param('action') as 'start' | 'stop';
    const body = await c.req.json() as { id?: string };
    if (!body.id || typeof body.id !== 'string') {
      return c.json({ error: 'Missing orchestrator "id" in request body' }, 400);
    }
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const logDir = getWorkspaceLogDir(workspacePath);

    const tools = await detectOrchestrationTools(workspacePath);
    const detection = tools.find((t) => t.id === body.id);
    if (!detection) {
      // A recorded tool that is no longer detected can still be stopped.
      if (action === 'stop' && await stopRecordedOrchestrator(body.id, workspacePath)) return c.json({ success: true });
      return c.json({ error: `Unknown orchestration tool "${body.id}" in this workspace.` }, 404);
    }

    if (action === 'start') {
      const running = await startOrchestrator(detection, workspacePath, logDir);
      return c.json({ success: true, orchestrator: running });
    }
    await stopOrchestrator(detection, workspacePath);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13. Get git changes in workspace sub-repositories
app.get('/api/workspace/:id/changes', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    // Load feature config to get repo paths
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    const results: any[] = [];
    const fingerprints: string[] = [];

    // Check git status in each repo (worktree, or source repo for in-place)
    for (const repoPath of feature.repos) {
      const repoName = path.basename(repoPath);
      const worktreePath = resolveFeatureRepoPath(feature, workspacePath, repoPath);

      try {
        const listing = await listRepositoryChangesWithFingerprint(worktreePath, c.req.query('include') === 'all');
        fingerprints.push(listing.fingerprint);

        results.push({
          repoName,
          repoPath: worktreePath,
          files: listing.files,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fingerprints.push(`error:${message}`);
        results.push({
          repoName,
          repoPath: worktreePath,
          files: [],
          error: message,
        });
      }
    }

    // A poller that already holds this state gets a small reply instead of
    // the full listing (100k entries for a large repository in Files mode).
    const token = createHash('sha1').update(JSON.stringify([id, feature.repos, fingerprints])).digest('hex');
    if (c.req.query('known') === token) return c.json({ unchanged: true, token });
    return c.json({ changes: results, token });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13_diff. Get git diff for a specific file in workspace sub-repositories
app.get('/api/workspace/:id/changes/diff', async (c) => {
  try {
    const id = c.req.param('id');
    const repoName = c.req.query('repo');
    const filePath = c.req.query('file');

    if (!repoName || !filePath) {
      return c.json({ error: 'Missing repo or file query parameter.' }, 400);
    }

    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    // Resolve by mode, manifest first: an in-place repo name may only resolve
    // to an exact manifest entry (its repos live outside the workspace), and
    // must never be shadowed by a stray same-named subdirectory inside the
    // workspace dir. Worktree mode keeps the path-containment guard.
    const feature = await loadFeatureConfig(workspacePath);
    let worktreePath: string;
    if (feature && isInPlace(feature)) {
      const matches = feature.repos.filter((r) => path.basename(r) === repoName);
      if (matches.length === 0) {
        return c.json({ error: `Unknown repo "${repoName}" in this workspace.` }, 404);
      }
      if (matches.length > 1) {
        return c.json({ error: `Repo name "${repoName}" is ambiguous in this workspace.` }, 400);
      }
      worktreePath = resolveFeatureRepoPath(feature, workspacePath, matches[0]!);
    } else {
      worktreePath = resolveRepoPath(workspacePath, repoName);
    }

    assertWithin(worktreePath, path.resolve(worktreePath, filePath));
    const normalizedFile = filePath.replace(/\\/g, '/');

    // Run git diff, disk file read, and git show HEAD in parallel
    const [diffResult, fileResult, originalResult] = await Promise.allSettled([
      execa('git', ['diff', 'HEAD', '--', filePath], { cwd: worktreePath, reject: false, maxBuffer: MAX_DIFF_BYTES }),
      readRepositoryFileForView(worktreePath, filePath),
      // Capped like the working copy: an oversized original reports isMaxBuffer instead of filling memory.
      execa('git', ['show', `HEAD:${normalizedFile}`], { cwd: worktreePath, reject: false, stripFinalNewline: false, maxBuffer: MAX_VIEWABLE_FILE_BYTES }),
    ]);

    let diff = '';
    // An enormous patch is as costly to send and to parse as an enormous file, so it is not sent.
    let diffOmitted = false;
    if (diffResult.status === 'fulfilled') {
      if (diffResult.value.isMaxBuffer) diffOmitted = true;
      else diff = diffResult.value.stdout || diffResult.value.stderr || '';
    }
    if (fileResult.status === 'rejected') {
      if (fileResult.reason instanceof RepositoryFileAccessError) throw new PathAccessError(fileResult.reason.message);
      throw fileResult.reason;
    }
    let fileContent = fileResult.value.content;
    let originalContent = '';
    // Why the full text was not loaded, if it was not. The viewer then shows the patch hunks only.
    let contentOmitted: OmittedReason | undefined = fileResult.value.omitted;
    let trackedAtHead = false;
    if (originalResult.status === 'fulfilled') {
      const original = originalResult.value;
      trackedAtHead = original.exitCode === 0 || Boolean(original.isMaxBuffer);
      if (original.isMaxBuffer) contentOmitted ??= 'too-large';
      else if (looksBinary(original.stdout || '')) contentOmitted ??= 'binary';
      else originalContent = original.stdout || '';
    }
    // Both sides or neither: a diff view of one real side against an empty one would mislead.
    if (contentOmitted) {
      fileContent = '';
      originalContent = '';
    }

    // Handle untracked new files if diff is empty but file exists on disk
    if (!diff && !diffOmitted && (fileContent || fileResult.value.omitted) && !trackedAtHead) {
      try {
        const untrackedDiff = await execa('git', ['diff', '--no-index', '--', '/dev/null', filePath], {
          cwd: worktreePath,
          reject: false,
          maxBuffer: MAX_DIFF_BYTES,
        });
        if (untrackedDiff.isMaxBuffer) diffOmitted = true;
        else diff = untrackedDiff.stdout || untrackedDiff.stderr || '';
      } catch {
        diff = '';
      }
    }
    // A diff too large to send means the file is too large to show in full as well.
    if (diffOmitted) {
      contentOmitted ??= 'too-large';
      fileContent = '';
      originalContent = '';
    }

    let symbols: any[] = [];
    if (fileContent) {
      try {
        symbols = await extractAstSymbols(filePath, fileContent);
      } catch {
        symbols = [];
      }
    }

    return c.json({ diff, fileContent, originalContent, symbols, ...(contentOmitted ? { contentOmitted } : {}), ...(diffOmitted ? { diffOmitted: true } : {}) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13_resolve. Which repository file a path printed in a terminal or a document names.
// The code view asks this instead of downloading the whole listing and matching it itself, and
// the answer covers ignored files and paths relative to the directory the session runs in.
app.get('/api/workspace/:id/files/resolve', async (c) => {
  try {
    const id = c.req.param('id');
    const reference = c.req.query('path');
    if (!reference) return c.json({ error: 'Missing path query parameter.' }, 400);
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) return c.json({ error: 'Workspace configuration not found.' }, 404);
    const repos = feature.repos.map((repoPath) => ({
      repoName: path.basename(repoPath),
      repoPath: resolveFeatureRepoPath(feature, workspacePath, repoPath),
    }));
    return c.json(await resolveFileReference(reference, {
      repos,
      workspacePath,
      cwd: c.req.query('cwd') || undefined,
      listFiles: async (repo) => (await listRepositoryChangesWithFingerprint(repo.repoPath, true)).files.map((file) => file.file),
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13_symbols. Fast batch symbol extraction across all modified files in workspace
app.get('/api/workspace/:id/changes/symbols', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    const allSymbols: any[] = [];

    // Concurrently scan modified files across repositories in feature
    await Promise.all(
      feature.repos.map(async (repoPath) => {
        const repoName = path.basename(repoPath);
        const worktreePath = resolveFeatureRepoPath(feature, workspacePath, repoPath);

        try {
          // -z with --untracked-files=all keeps renames, files in new directories
          // and paths with spaces intact; plain porcelain quotes or folds them.
          const { stdout } = await execa(
            'git',
            ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
            { cwd: worktreePath, stripFinalNewline: false },
          );

          const readPromises = parseGitStatus(stdout).map(async ({ file, type }) => {
            if (type === 'deleted') return; // Deleted files have no symbols on disk

            const ext = file.split('.').pop()?.toLowerCase();
            if (!ext || !['cs', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs'].includes(ext)) {
              return;
            }

            try {
              const { content, omitted } = await readRepositoryFileForView(worktreePath, file);
              if (omitted) return; // too large or binary: not worth a synchronous parse
              const extracted = await extractAstSymbols(file, content);
              if (extracted && extracted.length > 0) {
                for (const s of extracted) {
                  allSymbols.push({
                    ...s,
                    repoName,
                    repoPath: worktreePath,
                    filePath: file.replace(/\\/g, '/'),
                  });
                }
              }
            } catch {
              // Ignore unreadable or missing files
            }
          });

          await Promise.all(readPromises);
        } catch {
          // Ignore repo git status errors
        }
      })
    );

    return c.json({ symbols: allSymbols });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13b. Revert changes to specific files in workspace sub-repositories
app.post('/api/workspace/:id/changes/revert', async (c) => {
  if (!hasTrustedLocalOrigin(c.req.header('origin'))) {
    return c.json({ error: 'A local browser origin is required.' }, 403);
  }

  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null) as { repo?: string; files?: string[] } | null;
    const files = Array.isArray(body?.files) ? body.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0) : [];
    if (files.length === 0) {
      return c.json({ error: 'Missing files array in request body.' }, 400);
    }

    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const feature = await loadFeatureConfig(workspacePath);

    const repoName = typeof body?.repo === 'string' && body.repo ? body.repo : (feature?.repos[0] ? path.basename(feature.repos[0]) : null);

    let worktreePath: string;
    if (feature && isInPlace(feature)) {
      const matches = repoName ? feature.repos.filter((r) => path.basename(r) === repoName) : feature.repos;
      if (matches.length === 0) {
        return c.json({ error: `Unknown repo in this workspace.` }, 404);
      }
      if (matches.length > 1) {
        return c.json({ error: `Ambiguous repository '${repoName}' in this workspace. Multiple repositories match this name.` }, 400);
      }
      const boundary = describeEditBoundaries(feature, workspacePath).find((b) => b.name === path.basename(matches[0]!));
      if (boundary && !boundary.editable) {
        return c.json({ error: referenceRepoMessage(boundary.name), code: 'REFERENCE_REPO' }, 409);
      }
      worktreePath = resolveFeatureRepoPath(feature, workspacePath, matches[0]!);
    } else {
      worktreePath = repoName ? resolveRepoPath(workspacePath, repoName) : workspacePath;
    }

    // Snapshot git index so staged changes can be restored with 100% fidelity on rollback
    let indexPath: string | null = null;
    let originalIndexBuf: Buffer | null = null;
    try {
      const { stdout: gitPathOut } = await execa('git', ['rev-parse', '--git-path', 'index'], { cwd: worktreePath });
      const relIndexPath = gitPathOut.trim();
      if (relIndexPath) {
        indexPath = path.resolve(worktreePath, relIndexPath);
        try {
          originalIndexBuf = await fs.readFile(indexPath);
        } catch (readErr: any) {
          if (readErr?.code !== 'ENOENT') {
            return c.json({
              error: `Failed to snapshot Git index before revert: ${readErr?.message ?? String(readErr)}`,
            }, 500);
          }
          originalIndexBuf = null;
        }
      }
    } catch (gitErr: any) {
      return c.json({
        error: `Failed to resolve Git index path before revert: ${gitErr?.message ?? String(gitErr)}`,
      }, 500);
    }

    // Preflight: inspect all paths, statuses, and take snapshots for rollback
    interface PreflightItem {
      resolvedFile: string;
      relFile: string;
      isUntracked: boolean;
      exists: boolean;
      originalContent?: Buffer;
      originalMode?: number;
    }

    const preflightItems: PreflightItem[] = [];
    for (const file of files) {
      const resolvedFile = assertWithin(worktreePath, path.join(worktreePath, file));
      const relFile = path.relative(worktreePath, resolvedFile);

      const { stdout: statusOut } = await execa('git', ['status', '--porcelain', '--', relFile], { cwd: worktreePath });
      const statusLine = statusOut.trim();
      if (!statusLine) {
        continue;
      }

      // Preflight unsupported statuses: conflicts (U, AA, DD), submodules (S), typechanges (T)
      const code = statusLine.slice(0, 2);
      if (code.includes('U') || code === 'AA' || code === 'DD') {
        return c.json({
          error: `Cannot revert '${relFile}': file has unmerged git conflicts ('${statusLine}'). Resolve conflicts first.`,
        }, 400);
      }
      if (code.includes('S') || code.includes('T')) {
        return c.json({
          error: `Cannot revert '${relFile}': file has unsupported git status ('${statusLine}').`,
        }, 400);
      }

      const isUntracked = statusLine.startsWith('??');
      let exists = false;
      let originalContent: Buffer | undefined;
      let originalMode: number | undefined;

      try {
        let handle: fs.FileHandle | null = null;
        try {
          if (typeof fs.open === 'function') {
            handle = await fs.open(resolvedFile, 'r');
          }
          if (handle && typeof handle.readFile === 'function') {
            const [content, stat] = await Promise.all([
              handle.readFile(),
              typeof handle.stat === 'function' ? handle.stat() : Promise.resolve(undefined),
            ]);
            originalContent = content;
            originalMode = stat?.mode;
            exists = true;
          } else {
            originalContent = await fs.readFile(resolvedFile);
            exists = true;
          }
        } finally {
          if (handle && typeof handle.close === 'function') {
            await handle.close();
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
        exists = false;
      }

      preflightItems.push({
        resolvedFile,
        relFile,
        isUntracked,
        exists,
        originalContent,
        originalMode,
      });
    }

    // Execution with rollback protection: if any operation fails, restore previous state
    const executedReverts: PreflightItem[] = [];
    try {
      for (const item of preflightItems) {
        if (item.isUntracked) {
          if (item.exists) {
            await fs.unlink(item.resolvedFile);
          }
        } else {
          await execa('git', ['checkout', 'HEAD', '--', item.relFile], { cwd: worktreePath });
        }
        executedReverts.push(item);
      }
    } catch (revertErr: any) {
      const rollbackErrors: string[] = [];

      // 1. Restore the Git index first if it was snapshotted
      if (indexPath && originalIndexBuf) {
        try {
          await fs.writeFile(indexPath, originalIndexBuf);
        } catch (indexErr: any) {
          rollbackErrors.push(`Failed to restore git index: ${indexErr?.message ?? String(indexErr)}`);
        }
      }

      // 2. Restore modified working tree files and metadata
      for (const item of executedReverts) {
        try {
          if (item.isUntracked) {
            if (item.exists && item.originalContent) {
              await fs.writeFile(item.resolvedFile, item.originalContent);
              if (item.originalMode !== undefined && typeof fs.chmod === 'function') {
                try {
                  await fs.chmod(item.resolvedFile, item.originalMode);
                } catch (chmodErr: any) {
                  rollbackErrors.push(`Failed to restore mode on ${item.relFile}: ${chmodErr?.message ?? String(chmodErr)}`);
                }
              }
            }
          } else {
            if (item.exists && item.originalContent) {
              await fs.writeFile(item.resolvedFile, item.originalContent);
              if (item.originalMode !== undefined && typeof fs.chmod === 'function') {
                try {
                  await fs.chmod(item.resolvedFile, item.originalMode);
                } catch (chmodErr: any) {
                  rollbackErrors.push(`Failed to restore mode on ${item.relFile}: ${chmodErr?.message ?? String(chmodErr)}`);
                }
              }
            } else if (!item.exists) {
              try {
                await fs.unlink(item.resolvedFile);
              } catch (unlinkErr: any) {
                if (unlinkErr?.code !== 'ENOENT') {
                  rollbackErrors.push(`Failed to remove checked-out file ${item.relFile}: ${unlinkErr?.message ?? String(unlinkErr)}`);
                }
              }
            }
          }
        } catch (restoreErr: any) {
          rollbackErrors.push(`Failed to restore ${item.relFile}: ${restoreErr?.message ?? String(restoreErr)}`);
        }
      }

      if (rollbackErrors.length > 0) {
        return c.json({
          error: `Failed to revert files: ${revertErr?.message ?? String(revertErr)}. Warning: Rollback could not fully restore state: ${rollbackErrors.join('; ')}`,
        }, 500);
      }

      return c.json({
        error: `Failed to revert files: ${revertErr?.message ?? String(revertErr)}. Any modified files were rolled back.`,
      }, 500);
    }

    const reverted = preflightItems.map((item) => item.relFile);
    return c.json({ success: true, reverted });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13a. Get workspace knowledge (nexusflow-knowledge.md)
// Routed through the active storage adapter so the GUI edits the same file the
// generators write, whichever backend is active.
app.get('/api/workspace/:id/knowledge', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const content = (await readWorkspaceKnowledge(workspacePath)) ?? '# Workspace Knowledge\n\nNo knowledge file yet.';
    return c.json({ content });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13b. Update workspace knowledge (nexusflow-knowledge.md)
app.put('/api/workspace/:id/knowledge', async (c) => {
  try {
    const id = c.req.param('id');
    const { content } = await c.req.json() as { content: string };
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const feature = await loadFeatureConfig(workspacePath);
    const featureId = feature?.id ?? path.basename(workspacePath);
    const { PRIMARY_KNOWLEDGE_FILE, LEGACY_KNOWLEDGE_FILE } = await import('./core/constants.js');
    const { workspaceFileExists } = await import('./core/storage.js');
    const filename = (await workspaceFileExists(workspacePath, featureId, PRIMARY_KNOWLEDGE_FILE))
      ? PRIMARY_KNOWLEDGE_FILE
      : (await workspaceFileExists(workspacePath, featureId, LEGACY_KNOWLEDGE_FILE))
        ? LEGACY_KNOWLEDGE_FILE
        : PRIMARY_KNOWLEDGE_FILE;
    await writeWorkspaceFile(workspacePath, featureId, filename, content);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13b-2. Append a single structured learning (used for a GUI quick-add).
app.post('/api/workspace/:id/knowledge/entry', async (c) => {
  try {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      type: KnowledgeEntryType;
      message: string;
      title: string;
      scope?: string;
      evidence?: string;
      repo?: string;
    };
    if (!body.title?.trim()) {
      return c.json({ error: 'A short knowledge title is required.' }, 400);
    }
    if (!body.message?.trim()) {
      return c.json({ error: 'A knowledge message is required.' }, 400);
    }
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const result = body.repo
      ? await addBaseKnowledge(workspacePath, body.repo, {
          type: body.type,
          message: body.message,
          title: body.title,
          scope: body.scope,
          evidence: body.evidence,
        })
      : await addWorkspaceKnowledge(workspacePath, {
          type: body.type,
          message: body.message,
          title: body.title,
          scope: body.scope,
          evidence: body.evidence,
        });

    return c.json({ success: true, ...result });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c. Get workspace plan (contextspace-plan.md / nexusflow-plan.md)
app.get('/api/workspace/:id/plan', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { resolveWorkspaceFilePath } = await import('./core/brand-config.js');
    const resolved = await resolveWorkspaceFilePath(workspacePath, 'plan');

    let content = '';
    try {
      content = await fs.readFile(resolved.path, 'utf-8');
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        content = '# Workspace Plan\n\nNo implementation plan file yet.';
      } else {
        throw err;
      }
    }

    const state = await loadWorkspaceState(workspacePath);
    const { planStoreExists } = await import('./core/plan.js');
    if (state.lifecycle || await planStoreExists(workspacePath)) {
      const marker = /<!-- CONTEXTSPACE:MILESTONES:START -->[\s\S]*?<!-- CONTEXTSPACE:MILESTONES:END -->/;
      if (marker.test(content)) {
        // A file from before the plan summary: its milestone block is replaced with the live one.
        const { renderLifecyclePlan, loadWorkspaceLifecycle } = await import('./core/lifecycle.js');
        const milestones = renderLifecyclePlan(await loadWorkspaceLifecycle(workspacePath, { includeFleet: false }));
        content = content.replace(marker, () => milestones);
      } else {
        // The summary as it reads now, keeping the build order the last refresh wrote.
        const { buildPlanSummary, buildOrderOf } = await import('./core/plan-summary.js');
        content = await buildPlanSummary(workspacePath, { buildOrder: buildOrderOf(content) ?? '' });
      }
    }
    return c.json({ content });
  } catch (error) {
    return errorResponse(c, error);
  }
});

registerWorkGuidanceRoutes(app, async (id) => {
  const config = await loadConfig();
  return resolveExactWorkspaceById(config.workspacesDir, id);
});
registerPlanRoutes(app, async (id) => {
  const config = await loadConfig();
  return resolveExactWorkspaceById(config.workspacesDir, id);
});
registerNeedsYouRoute(app, async (id) => {
  const config = await loadConfig();
  return resolveExactWorkspaceById(config.workspacesDir, id);
});

// 13c-1. Get active workspace lifecycle and sister branch fleet
app.get('/api/workspace/:id/lifecycle', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { loadWorkspaceLifecycle, renderLifecyclePlan } = await import('./core/lifecycle.js');
    const lifecycle = await loadWorkspaceLifecycle(workspacePath);
    const report = (await loadWorkspaceState(workspacePath)).lastVerification ?? null;
    return c.json({ lifecycle, report, plan: renderLifecyclePlan(lifecycle) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2. Transition or advance a lifecycle step
app.post('/api/workspace/:id/lifecycle/step', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const body = (await c.req.json().catch(() => ({}))) as {
      stepId?: string;
      action?: 'start' | 'verify' | 'complete';
    };
    if (!body.stepId || !body.action) {
      return c.json({ error: 'stepId and action (start|verify|complete) are required.' }, 400);
    }
    const { advanceLifecycleStep } = await import('./core/lifecycle.js');
    const lifecycle = await advanceLifecycleStep(workspacePath, body.stepId, body.action, { by: 'user' });
    return c.json({ lifecycle });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2a. Whether the notes a person wrote in this workspace would survive losing this computer.
// Read-only on purpose. There is deliberately no route that adds a remote or pushes: this server
// has no login, so such a route would let any local program send the workspace's notes to a
// repository of its choosing. Setting a remote and pushing stay with `ctxspace remote add|push`.
app.get('/api/workspace/:id/backup', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { describeWorkspaceBackup } = await import('./core/workspace-backup.js');
    return c.json({ backup: await describeWorkspaceBackup(workspacePath) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2b. Checkable progress facts: milestones (with reopened work), open questions,
// changed files and the last verification. Cheap enough to poll: no remote queries.
app.get('/api/workspace/:id/progress-facts', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { getProgressFacts } = await import('./core/progress-facts.js');
    return c.json({ facts: await getProgressFacts(workspacePath) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2c. Send a finished milestone back for rework. This route is the user's own
// action, so the reopen is recorded as theirs.
app.post('/api/workspace/:id/lifecycle/reopen', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const body = (await c.req.json().catch(() => ({}))) as { stepId?: unknown; reason?: unknown };
    if (typeof body.stepId !== 'string' || !body.stepId || typeof body.reason !== 'string') {
      return c.json({ error: 'stepId and reason are required.' }, 400);
    }
    const { reopenLifecycleStep, LifecycleStepError } = await import('./core/lifecycle.js');
    try {
      const lifecycle = await reopenLifecycleStep(workspacePath, body.stepId, { reason: body.reason, by: 'user' });
      return c.json({ lifecycle });
    } catch (error) {
      if (error instanceof LifecycleStepError) {
        return c.json({ error: error.message, code: error.code }, error.code === 'not_found' ? 404 : 409);
      }
      // A rejected reason (empty or too long) is the caller's mistake, not a server fault.
      if (error instanceof Error && error.name === 'ZodError') {
        const issues = (error as Error & { issues?: Array<{ message?: string }> }).issues;
        return c.json({ error: issues?.[0]?.message ?? 'The reason is not valid.' }, 400);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2d. Mark every question the AI has asked so far as answered. Replies typed into
// the chat terminal never reach the ledger, so the app records this explicitly. The same
// questions in the plan are answered too; a plan that cannot be changed keeps the answer.
app.post('/api/workspace/:id/input-requests/acknowledge', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { acknowledged, timestamp, requests } = await acknowledgeInputRequests(workspacePath);
    const planAnswered = await answerChatQuestionsInPlan(workspacePath, requests.map((request) => request.message)).catch(() => []);
    return c.json({ acknowledged, timestamp, planAnswered });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2e. The live feed for a workspace's screen: what the AI told it to show, the questions the AI
// asked, and when they were answered. A screen that reconnects sends the time of the last event it saw,
// as `since` or as the standard Last-Event-ID header (each event's id is its timestamp).
function liveEventId(live: LiveEvent): string {
  return live.type === 'screen' ? live.event.timestamp : live.type === 'question' ? live.request.timestamp : live.timestamp;
}
app.get('/api/workspace/:id/screen-events', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const sinceText = c.req.query('since') ?? c.req.header('last-event-id');
    const parsed = sinceText ? Date.parse(sinceText) : NaN;
    const since = Number.isFinite(parsed) ? parsed : undefined;

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      // A comment-sized event now and then keeps proxies from closing a quiet connection and lets a dead one be noticed.
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => controller.abort());
      }, 15_000);
      try {
        for await (const live of watchLiveEvents(workspacePath, { since, signal: controller.signal })) {
          await stream.writeSSE({ event: live.type, id: liveEventId(live), data: JSON.stringify(live) });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2f. Whether the user shares what they are looking at with the AI. Off until they switch it on;
// switching it off deletes what was stored.
app.get('/api/workspace/:id/screen-sharing', async (c) => {
  try {
    const config = await loadConfig();
    return c.json(await getScreenSharing(resolveWorkspacePath(config.workspacesDir, c.req.param('id'))));
  } catch (error) {
    return errorResponse(c, error);
  }
});
app.put('/api/workspace/:id/screen-sharing', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (true or false) is required.' }, 400);
    return c.json(await setScreenSharing(workspacePath, body.enabled));
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2g. What the screen reports it is showing, and what the AI would see if it asked. Reporting is
// refused while sharing is off, so a screen that has not been told to share cannot leak anything.
app.get('/api/workspace/:id/screen-context', async (c) => {
  try {
    const config = await loadConfig();
    return c.json(await readScreenContext(resolveWorkspacePath(config.workspacesDir, c.req.param('id'))));
  } catch (error) {
    return errorResponse(c, error);
  }
});
app.put('/api/workspace/:id/screen-context', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const body = await c.req.json().catch(() => undefined);
    try {
      return c.json({ context: await saveScreenContext(workspacePath, body ?? {}) });
    } catch (error) {
      if (error instanceof ScreenSharingOffError) return c.json({ error: error.message, code: 'sharing_off' }, 409);
      throw error;
    }
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-3. Run mechanical verification gate for workspace
app.post('/api/workspace/:id/verify', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const body = (await c.req.json().catch(() => ({}))) as {
      repoName?: string;
      filter?: string;
      command?: string;
      allowDirty?: boolean;
    };
    const { verifyWorkspace } = await import('./core/verify.js');
    const report = await verifyWorkspace(workspacePath, {
      repoName: body.repoName,
      filter: body.filter,
      command: body.command,
      allowDirty: body.allowDirty,
    });
    return c.json({ report });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-2. Check workspace migration status (legacy NexusFlow files detected)
app.get('/api/workspace/:id/migration-status', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { isLegacyWorkspace } = await import('./core/migrate.js');
    const isLegacy = await isLegacyWorkspace(workspacePath);
    return c.json({ isLegacy });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-3. Migrate legacy workspace to native ContextSpace
app.post('/api/workspace/:id/migrate', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);
    const { migrateWorkspace } = await import('./core/migrate.js');
    const report = await migrateWorkspace(workspacePath, { dryRun: false, refresh: true });
    return c.json(report);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-4. Get workspace collaboration stream (.nexusflow/chat.jsonl or .contextspace/chat.jsonl)
app.get('/api/workspace/:id/stream', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const { messages, ledgerInfo } = await readWorkspaceChatMessages(workspacePath);

    let isRemoteActive = false;
    let remoteStatus: any = null;
    let workflowProgress: any = null;

    try {
      const client = await workroomManagerModule.loadPinnedWorkroomClientForWorkspace(id);
      const snapshot = await client.snapshot();
      isRemoteActive = true;
      workflowProgress = snapshot.workflowProgress ?? null;
      remoteStatus = {
        roomId: snapshot.roomId,
        name: snapshot.name,
      };
    } catch {
      // Fallback to in-process workroomManager
      try {
        if (workroomManagerModule.workroomManager.hasActiveRoom()) {
          const status = await workroomManagerModule.workroomManager.status();
          if ((status.mode === 'host' || status.mode === 'guest') && status.localWorkspaceId === id) {
            isRemoteActive = true;
            workflowProgress = status.snapshot?.workflowProgress ?? null;
            remoteStatus = {
              roomId: status.roomId,
              url: status.url,
              name: (status as any).name,
            };
          }
        }
      } catch {
        // ignore
      }
    }

    // Reconcile messages with live authoritative workflow progress by stepId
    const stepMap = new Map<string, any>();
    if (workflowProgress?.steps) {
      for (const step of workflowProgress.steps) {
        stepMap.set(step.stepId, step);
      }
    }

    const reconciledMessages = messages.map((msg) => {
      if (!msg.stepId) return msg;
      const liveStep = stepMap.get(msg.stepId);
      if (!liveStep) return msg;
      return {
        ...msg,
        stepProposal: liveStep,
      };
    });

    const relLedgerPath = ledgerInfo.isLegacy ? '.nexusflow/chat.jsonl' : '.contextspace/chat.jsonl';
    return c.json({
      workspaceId: id,
      messages: reconciledMessages,
      workflowProgress,
      isRemoteActive,
      remoteStatus,
      isLegacy: ledgerInfo.isLegacy,
      ledgerPath: relLedgerPath,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-5. Post a message to workspace collaboration stream
app.post('/api/workspace/:id/stream', async (c) => {
  try {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      message: string;
      harness?: string;
      author?: string;
      status?: string;
      stepId?: string;
      evidence?: string;
    };
    const message = String(body.message ?? '').trim();
    if (!message) {
      return c.json({ error: 'Message cannot be empty.' }, 400);
    }

    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const ledger = await resolveWorkspaceChatLedger(workspacePath);
    await fs.mkdir(ledger.chatDir, { recursive: true });
    const chatFile = ledger.chatPath;

    const isHuman = body.author === 'human' || body.harness === 'developer' || body.harness === 'human';
    const status = body.status ? String(body.status).trim() : (body.stepId ? 'proposed' : undefined);
    const effectiveStatus = (!isHuman && status === 'completed') ? 'proposed' : status;

    const entry = {
      id: createHash('sha256').update(Date.now() + message).digest('hex').slice(0, 12),
      timestamp: new Date().toISOString(),
      harness: body.harness || (isHuman ? 'developer' : 'agent'),
      author: isHuman ? 'human' : 'agent',
      status: effectiveStatus,
      message,
      ...(body.stepId ? { stepId: body.stepId } : {}),
      ...(body.evidence ? { evidence: body.evidence } : {}),
      ...(isHuman && effectiveStatus === 'completed' ? { confirmedBy: 'human', confirmedAt: new Date().toISOString() } : {}),
    };

    await fs.appendFile(chatFile, JSON.stringify(entry) + '\n', 'utf-8');

    return c.json({ success: true, entry });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13c-6. Newest "agent needs input" request for each named workspace (the open CLI chats).
// Cheap by design: it only tail-reads the ledgers of the ids it is given, no directory scan.
const ATTENTION_MAX_WORKSPACES = 100;
app.get('/api/attention', async (c) => {
  try {
    const config = await loadConfig();
    const ids = [...new Set((c.req.query('workspaces') ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
      .slice(0, ATTENTION_MAX_WORKSPACES);
    const found = await Promise.all(ids.map(async (workspaceId) => {
      try {
        const request = await latestInputRequest(resolveWorkspacePath(config.workspacesDir, workspaceId));
        return request ? { workspaceId, ...request } : null;
      } catch {
        // An id outside the workspaces directory or an unreadable ledger is not an alert.
        return null;
      }
    }));
    return c.json({ requests: found.filter((request): request is InputRequest & { workspaceId: string } => request !== null) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13d. Sync all repositories in workspace
app.post('/api/workspace/:id/sync', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const report = await syncWorkspace(workspacePath);
    const results = report.repos.map((repo) => ({
      repoName: repo.name,
      success: repo.status !== 'conflict' && repo.status !== 'error',
      status: repo.status,
      message: repo.message,
      conflict: repo.conflict,
    }));

    return c.json({
      results,
      syncedCount: report.syncedCount,
      conflictCount: report.conflictCount,
      errorCount: report.errorCount,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13e. Commit changes in all repositories in workspace
app.post('/api/workspace/:id/commit', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null) as { message?: unknown; noPush?: unknown; files?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({ error: 'A commit message is required.' }, 400);
    let files: Record<string, string[]> | undefined;
    if (body?.files !== undefined) {
      if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) {
        return c.json({ error: '"files" must map repository names to file lists.' }, 400);
      }
      files = {};
      for (const [repo, list] of Object.entries(body.files as Record<string, unknown>)) {
        if (!Array.isArray(list) || list.some((file) => typeof file !== 'string' || !file)) {
          return c.json({ error: `"files.${repo}" must be a list of file paths.` }, 400);
        }
        files[repo] = list as string[];
      }
      if (Object.values(files).every((list) => list.length === 0)) {
        return c.json({ error: 'Select at least one file to commit.' }, 400);
      }
    }
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    const report = await commitWorkspace(workspacePath, message, { noPush: body?.noPush === true, files });
    const results = report.repos.map((repo) => ({
      repoName: repo.name,
      success: repo.success,
      committed: repo.committed,
      pushed: repo.pushed,
      pushError: repo.pushError,
      branch: repo.branch,
      commitHash: repo.commitHash,
      filesChanged: repo.filesChanged,
      message: repo.message,
    }));

    return c.json({ results, skipped: report.skipped, conventionWarning: report.conventionWarning });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13e-2. Push already-committed work (the retry after a failed push).
app.post('/api/workspace/:id/push', async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as { repos?: unknown } | null;
    const repos = Array.isArray(body?.repos) ? body.repos.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
    if (repos.length === 0) return c.json({ error: 'Name at least one repository to push.' }, 400);
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    return c.json({ results: await pushWorkspace(workspacePath, repos) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13f. Live per-repository state: edit boundary, branch, HEAD and changes.
app.get('/api/workspace/:id/repositories', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) return c.json({ error: 'Workspace not found.' }, 404);
    const boundaries = new Map(describeEditBoundaries(feature, workspacePath).map((b) => [b.name, b]));
    const status = await getWorkspaceStatusReport(workspacePath);
    return c.json({
      repositories: status.repos.map((repo) => ({
        name: repo.name,
        access: repo.access,
        editable: repo.editable,
        path: repo.path,
        sourcePath: repo.sourcePath,
        branch: repo.branch,
        expectedBranch: repo.editable ? repo.expectedBranch : null,
        onExpectedBranch: repo.onExpectedBranch,
        baseBranch: boundaries.get(repo.name)?.baseBranch ?? repo.defaultBranch,
        headSha: repo.headSha ?? null,
        dirty: repo.dirty,
        changedFiles: repo.changedFiles,
        ahead: repo.ahead,
        behind: repo.behind,
        remoteUrl: repo.remoteUrl,
      })),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13g. The shared finish policy decision for the current content.
app.get('/api/workspace/:id/progression', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    return c.json(await evaluateProgression(workspacePath));
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 13h. Finish: policy check, commit, push and PR links; dry run previews effects.
app.post('/api/workspace/:id/finish', async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as {
      message?: unknown; skipPush?: unknown; createPrs?: unknown; overrideReason?: unknown; dryRun?: unknown;
    } | null;
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const overrideReason = typeof body?.overrideReason === 'string' ? body.overrideReason : undefined;
    const report = await finishWorkspace(workspacePath, {
      message: typeof body?.message === 'string' ? body.message : undefined,
      skipPush: body?.skipPush === true,
      createPrs: body?.createPrs === true,
      override: overrideReason !== undefined ? { reason: overrideReason } : undefined,
      dryRun: body?.dryRun === true,
    });
    return c.json(report, report.blocked ? 409 : 200);
  } catch (error) {
    if (error instanceof Error && /override needs a reason/.test(error.message)) {
      return c.json({ error: error.message }, 400);
    }
    return errorResponse(c, error);
  }
});

// 13i. The durable record of the latest finish run, for resuming after a restart.
app.get('/api/workspace/:id/finish/last', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const state = await loadWorkspaceState(workspacePath);
    return c.json({ lastFinish: state.lastFinish ?? null });
  } catch (error) {
    return errorResponse(c, error);
  }
});


// 14. Resume session in workspace (copies CLI resume command and opens editor)
app.post('/api/workspace/:id/resume', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !hasTrustedLocalOrigin(origin)) {
    return c.json({ error: 'Forbidden cross-origin request.' }, 403);
  }

  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, id);

    // Load feature config to get repo paths
    const feature = await loadFeatureConfig(workspacePath);
    if (!feature) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: unknown;
      assistant?: unknown;
      command?: unknown;
    };
    const targetSessionId = typeof body.sessionId === 'string' && isValidSessionUuid(body.sessionId) ? body.sessionId : undefined;
    if (body.sessionId !== undefined && targetSessionId === undefined) {
      return c.json({ error: 'Invalid session UUID format.' }, 400);
    }
    if (body.command !== undefined && (typeof body.command !== 'string' || !ALLOWED_EDITORS.has(body.command))) {
      return c.json({ error: 'Forbidden editor command' }, 400);
    }
    const targetAssistant = typeof body.assistant === 'string' ? body.assistant : undefined;

    // Find the session to resume
    let resumeCommand = '';
    let selectedAssistant = targetAssistant || feature.assistants[0] || 'antigravity';
    let selectedSessionId = targetSessionId;

    if (!selectedSessionId) {
      // Find the most recent session matching this workspace
      const sessions = await findSessions(workspacePath, feature.repos);
      if (sessions.length > 0) {
        selectedSessionId = sessions[0].id;
        selectedAssistant = sessions[0].assistant;
      }
    }

    if (selectedSessionId) {
      if (SUPPORTED_ASSISTANTS.has(selectedAssistant)) resumeCommand = buildHarnessCliCommand(selectedAssistant, selectedSessionId);
    } else {
      resumeCommand = buildHarnessContinueCommand(SUPPORTED_ASSISTANTS.has(selectedAssistant) ? selectedAssistant : 'antigravity');
    }

    // Open in editor if command is provided
    if (body.command) {
      if (!ALLOWED_EDITORS.has(body.command)) {
        return c.json({ error: 'Forbidden editor command' }, 400);
      }
      try {
        await openInEditor(body.command, workspacePath);
      } catch (err) {
        console.error(`Failed to launch editor ${body.command} for path ${workspacePath}:`, err);
      }
    }

    // Where the resume command should be run: the workspace dir, or the repo
    // root for single-repo in-place features.
    return c.json({ success: true, resumeCommand, workspacePath, sessionCwd: getSessionCwd(feature) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// The GUI asks the backend which history readers exist, then loads each one independently.
app.get('/api/session-sources', c => c.json({ sources: SESSION_SOURCES }));

// 15. List past AI sessions for a workspace
app.get('/api/workspace/:id/sessions', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const limitParam = c.req.query('limit');
    const desktopHandoffOnly = c.req.query('desktopHandoffOnly') === 'true';
    const sourceParam = c.req.query('source');
    const source = SESSION_SOURCES.find((candidate) => candidate === sourceParam);
    if (sourceParam && !source) {
      return c.json({ error: 'Choose a valid session source.' }, 400);
    }
    if (source && desktopHandoffOnly) {
      return c.json({ error: 'Session source cannot be combined with desktop handoff.' }, 400);
    }
    let limit: number | undefined;
    if (limitParam !== undefined) {
      limit = Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        return c.json({ error: 'Session limit must be an integer from 1 to 20.' }, 400);
      }
    }
    const config = await loadConfig();
    const requestedWorkspacePath = resolveWorkspacePath(config.workspacesDir, id);
    let workspacePath = requestedWorkspacePath;
    let feature;
    if (desktopHandoffOnly) {
      try {
        const exactWorkspacePath = await resolveExactLaunchWorkspace(config.workspacesDir, requestedWorkspacePath);
        if (!exactWorkspacePath) {
          return c.json({ error: 'Workspace configuration not found.' }, 404);
        }
        workspacePath = exactWorkspacePath;
      } catch (error) {
        if (error instanceof PathAccessError) throw error;
        return c.json({ error: 'Workspace configuration not found.' }, 404);
      }
      feature = await loadWorkspaceManifest(workspacePath);
    } else {
      feature = await loadFeatureConfig(workspacePath);
    }
    if (!feature) {
      return c.json({ error: 'Workspace configuration not found.' }, 404);
    }

    const discoveredSessions = await findSessions(workspacePath, feature.repos, source);
    if (!desktopHandoffOnly) {
      return c.json({ sessions: limit === undefined ? discoveredSessions : discoveredSessions.slice(0, limit) });
    }

    const requestedCount = limit ?? 3;
    const candidates = discoveredSessions
      .filter((session) => session.threadKind !== 'subagent' && (session.assistant === 'codex' || session.assistant === 'claude'))
      .slice(0, DESKTOP_HANDOFF_SCAN_LIMIT);
    const sessions = [];
    const claudeTransferAvailable = candidates.some((session) => session.assistant === 'claude')
      && canOfferClaudeDesktopTransfer();
    for (const session of candidates) {
      if (session.assistant === 'codex' && await canOpenCodexSessionInWorkspace(
        workspacePath,
        feature.repos,
        session.id,
      )) {
        sessions.push({
          ...session,
          desktopHandoff: { targetId: 'codex-desktop' as const, method: 'direct' as const },
        });
      } else if (
        session.assistant === 'claude'
        && claudeTransferAvailable
        && await canTransferClaudeSessionInWorkspace(workspacePath, feature.repos, session.id)
      ) {
        sessions.push({
          ...session,
          desktopHandoff: { targetId: 'claude-desktop' as const, method: 'guided' as const },
        });
      }
      if (sessions.length === requestedCount) break;
    }
    return c.json({ sessions });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 16. Fetch transcript for a specific AI session
app.get('/api/session/:assistant/:sessionId/transcript', async (c) => {
  const assistant = c.req.param('assistant');
  const sessionId = c.req.param('sessionId');
  try {
    if (!SUPPORTED_ASSISTANTS.has(assistant.trim().toLowerCase())) {
      return c.json({ error: `Unsupported assistant: "${assistant}".` }, 400);
    }
    if (!isValidSessionUuid(sessionId)) {
      return c.json({ error: 'Invalid session UUID format.' }, 400);
    }

    const messages = await getSessionTranscript(assistant, sessionId);
    return c.json({ messages });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 17. Check for NexusFlow updates
app.get('/api/update-status', async (c) => {
  try {
    const status = await checkForUpdates(false);
    if (!status) {
      const currentVersion = getCurrentVersion();
      return c.json({ currentVersion, latestVersion: currentVersion, updateAvailable: false });
    }
    return c.json(status);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 17.5. Check tools updates status
app.get('/api/updates/tools', async (c) => {
  try {
    const force = c.req.query('force') === 'true';
    const status = await getToolsStatus(force);
    return c.json(status);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 17.6. Install updates for a specific tool
app.post('/api/updates/install', async (c) => {
  try {
    const { toolId } = await c.req.json() as { toolId: string };
    const tools = [
      { id: ENGINE_ID, cmd: 'npm', args: ['install', '-g', ENGINE_NPM_PACKAGE] },
      { id: LEGACY_ENGINE_ID, cmd: 'npm', args: ['install', '-g', LEGACY_ENGINE_NPM_PACKAGE] },
      { id: 'antigravity', cmd: 'agy', args: ['update'] },
      { id: 'claude', cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
    ];

    const target = tools.find(t => t.id === toolId);
    if (!target) {
      return c.json({ error: 'Tool not found' }, 404);
    }

    const result = await execa(target.cmd, target.args, {
      reject: false,
      shell: process.platform === 'win32',
    });
    if (result.exitCode === 0) {
      return c.json({ success: true, output: result.stdout });
    } else {
      return c.json({ error: `Update failed: ${result.stderr || result.stdout}` }, 500);
    }
  } catch (error) {
    return errorResponse(c, error);
  }
});

// 17.9. Get available workflow templates
app.get('/api/workflows/templates', async (c) => {
  try {
    const templates = await getWorkflowTemplates();
    return c.json({ templates });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Save or update custom teamwork template
app.post('/api/workflows/templates', async (c) => {
  try {
    const { id, name, content } = await c.req.json();
    if (!name || !content) {
      return c.json({ error: 'Name and content are required.' }, 400);
    }
    const template = await saveWorkflowTemplate(name, content, id);
    return c.json({ success: true, template });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Delete custom teamwork template
app.delete('/api/workflows/templates/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const templates = await getWorkflowTemplates();
    const target = templates.find(t => t.id === id);
    if (!target) {
      return c.json({ error: 'Template not found.' }, 404);
    }
    if (!target.custom) {
      return c.json({ error: 'Cannot delete built-in templates.' }, 403);
    }
    await deleteWorkflowTemplate(id);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Analyze teamwork template rules via selected AI coding assistant harness
app.post('/api/workflows/templates/:id/analyze', async (c) => {
  try {
    const { content, assistant, comment } = await c.req.json();
    if (!content) {
      return c.json({ error: 'Content is required.' }, 400);
    }

    const selectedAssistant = assistant || 'antigravity';
    let command = '';
    let args: string[] = [];
    let commandInput = '';

    let prompt = `You are an expert AI system engineering reviewer. Analyze the following Agent Teamwork Strategy guidelines.
Evaluate its instructions, identify any ambiguities or contradictions, rate its expected effectiveness for orchestrating subagents, and provide specific recommendations or improvements. Format your analysis in clean Markdown with clear headings (e.g. Overview, Strengths, Weaknesses, Recommendations).

After your analysis, provide a fully rewritten, optimized, and complete version of the strategy guidelines incorporating all your recommendations. This rewritten version must be suitable for production orchestration.
You MUST prefix the rewritten version with the exact delimiter line:
=== SUGGESTED IMPROVEMENT START ===
and suffix it with:
=== SUGGESTED IMPROVEMENT END ===`;

    if (comment && comment.trim()) {
      prompt += `\n\nIMPORTANT: The user has provided the following specific instruction/comment that you MUST consider and prioritize during your evaluation and when rewriting the guidelines:\n"${comment.trim()}"`;
    }

    prompt += `\n\n--- GUIDELINES START ---\n${content}\n--- GUIDELINES END ---`;

    const assistants = await detectAIAssistants();
    const target = assistants.find(ai => ai.name === selectedAssistant);
    
    if (!target || !target.detected || !target.command) {
      return c.json({
        error: `AI assistant harness '${selectedAssistant}' is not detected or does not support command-line execution.`
      }, 400);
    }

    command = target.command;
    if (command === 'claude') {
      args = ['-p', prompt];
    } else if (command === 'agy') {
      args = [prompt];
    } else if (command === 'codex') {
      // Captured stdio cannot host the interactive TUI. `codex exec` is the
      // supported non-interactive surface and reuses the user's CLI login.
      args = ['exec', '--color', 'never', '-'];
      commandInput = prompt;
    } else {
      args = [prompt];
    }

    const result = await execa(command, args, {
      input: commandInput,
      shell: false,
      reject: false
    });

    if (result.exitCode !== 0) {
      return c.json({
        error: `AI Assistant harness execution failed (exit code ${result.exitCode}): ${result.stderr || result.stdout || 'Unknown error'}`
      }, 500);
    }

    // Clean potential warning lines or stdout prefixes if present
    let cleanText = result.stdout;
    if (cleanText.includes('Warning: no stdin data received')) {
      cleanText = cleanText.replace(/Warning: no stdin data received in \d+s, proceeding without it\. If piping from a slow command, redirect stdin explicitly: < \/dev\/null to skip, or wait longer\.\r?\n?/, '');
    }

    let analysis = cleanText.trim();
    let suggestedImprovement = '';

    const startDelimiter = '=== SUGGESTED IMPROVEMENT START ===';
    const endDelimiter = '=== SUGGESTED IMPROVEMENT END ===';

    const startIdx = cleanText.indexOf(startDelimiter);
    const endIdx = cleanText.indexOf(endDelimiter);

    if (startIdx !== -1 && endIdx !== -1) {
      analysis = cleanText.substring(0, startIdx).trim();
      suggestedImprovement = cleanText.substring(startIdx + startDelimiter.length, endIdx).trim();
    }

    return c.json({ analysis, suggestedImprovement });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// ─── Skills & Categories Catalog ──────────────────────────────────────────

// Get all skill categories (built-in templates + user custom)
app.get('/api/skills/categories', async (c) => {
  try {
    const categories = await getSkillCategories();
    return c.json({ categories });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Save or update a custom skill category
app.post('/api/skills/categories', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: 'Category name is required.' }, 400);
    }
    const category = await saveSkillCategory(body);
    return c.json({ success: true, category });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Delete a custom skill category
app.delete('/api/skills/categories/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    await deleteSkillCategory(id);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Include authored workspace packages; generated global copies still resolve to their catalog source.
const resourcePreviewInput = z.object({
  skills: z.array(z.string().max(200)).max(200).default([]),
  agents: z.array(z.string().max(200)).max(200).default([]),
  assistants: z.array(z.string().max(40)).max(20).default([]),
});
const RESOURCE_ASSISTANTS = new Set(['claude', 'antigravity', 'codex', 'copilot', 'cursor']);

// What a new workspace would receive for the chosen skills and agents.
app.post('/api/resources/preview', async (c) => {
  const parsed = resourcePreviewInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid resource selection' }, 400);
  try {
    // Assistants without resource support (e.g. a CLI-only tool) simply get no files.
    const assistants = parsed.data.assistants.filter((name) => RESOURCE_ASSISTANTS.has(name)) as AIAssistant[];
    return c.json({ resources: await previewResourceSelections(parsed.data.skills, parsed.data.agents, assistants) });
  } catch (error) {
    if (error instanceof ResourceSelectionError) return c.json({ error: error.message }, 400);
    return errorResponse(c, error);
  }
});

app.get('/api/skills', async (c) => {
  try {
    const config = await loadConfig();
    const wsParam = c.req.query('workspace');
    let wsPath: string | undefined;
    if (wsParam && wsParam !== 'global') {
      wsPath = (await resolveExactWorkspaceById(config.workspacesDir, wsParam)) || undefined;
      if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    }
    const diagnostics: import('./utils/skills-catalog.js').SkillDiagnostic[] = [];
    const skills = await getAllSkills(wsPath, diagnostics);
    return c.json({ skills, diagnostics });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Save or update a custom skill
app.post('/api/skills', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name || !body.content) {
      return c.json({ error: 'Skill name and content are required.' }, 400);
    }
    const config = await loadConfig();
    const wsParam = body.workspaceId || body.workspace || c.req.query('workspace');
    let wsPath: string | undefined;
    if (wsParam && wsParam !== 'global') {
      wsPath = (await resolveExactWorkspaceById(config.workspacesDir, wsParam)) || undefined;
      if (!wsPath) {
        return c.json({ error: `Workspace "${wsParam}" not found.` }, 404);
      }
    }
    if (body.scope === 'workspace' && !wsPath) {
      return c.json({ error: 'A valid workspace is required when saving a workspace-scoped skill.' }, 400);
    }
    const isWorkspaceScope = body.scope === 'workspace' || (Boolean(wsPath) && body.scope !== 'global');
    const options = isWorkspaceScope && wsPath
      ? { scope: 'workspace' as const, workspacePath: wsPath }
      : { scope: 'global' as const };

    const skill = await saveSkill(body, options);
    return c.json({ success: true, skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

// Delete a custom skill
app.delete('/api/skills/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const wsParam = c.req.query('workspace');
    let wsPath: string | undefined;
    if (wsParam && wsParam !== 'global') {
      wsPath = (await resolveExactWorkspaceById(config.workspacesDir, wsParam)) || undefined;
      if (!wsPath) {
        return c.json({ error: `Workspace "${wsParam}" not found.` }, 404);
      }
    }
    if (wsPath) {
      await deleteSkill(id, { scope: 'workspace', workspacePath: wsPath });
      return c.json({ success: true });
    }
    const assignments = await withResourceAdministrationLock(async () => {
      const currentAssignments = await findResourceAssignments(config.workspacesDir, id, 'skill');
      if (!currentAssignments.length) await deleteSkill(id);
      return currentAssignments;
    });
    if (assignments.length) {
      return c.json({
        error: `Unassign the skill from these workspaces before deleting it: ${assignments.join(', ')}`,
        workspaces: assignments,
      }, 409);
    }
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

// Codex-native custom-agent catalog. Other harness agent formats are not
// translated because their configuration and permission models are different.
app.get('/api/agents', async (c) => {
  try {
    return c.json({ agents: await getAllAgents() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/agents', async (c) => {
  try {
    const agent = await saveAgent(await c.req.json());
    return c.json({ success: true, agent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.post('/api/agents/import', async (c) => {
  try {
    const body = await c.req.json();
    if (typeof body.toml !== 'string') {
      return c.json({ error: 'A TOML string is required.' }, 400);
    }
    const agent = await importAgentToml(body.toml, typeof body.category === 'string' ? body.category : 'general');
    return c.json({ success: true, agent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 400);
  }
});

app.delete('/api/agents/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const assignments = await withResourceAdministrationLock(async () => {
      const currentAssignments = await findResourceAssignments(config.workspacesDir, id, 'agent');
      if (!currentAssignments.length) await deleteAgent(id);
      return currentAssignments;
    });
    if (assignments.length) {
      return c.json({
        error: `Unassign the agent from these workspaces before deleting it: ${assignments.join(', ')}`,
        workspaces: assignments,
      }, 409);
    }
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Get workspace skills assignment config
app.get('/api/skills/workspace/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const wsPath = await resolveExactWorkspaceById(config.workspacesDir, id);
    if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    const skillsConfig = await getWorkspaceSkillsConfig(wsPath);
    return c.json({ config: skillsConfig });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Save workspace skills assignment config
app.post('/api/skills/workspace/:id/assign', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json();
    if (!Array.isArray(body.enabledSkills) || !Array.isArray(body.enabledAgents)) {
      return c.json({ error: 'enabledSkills and enabledAgents arrays are required.' }, 400);
    }
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      return c.json({ error: 'A nonnegative integer expectedRevision is required.' }, 400);
    }
    const config = await loadConfig();
    const wsPath = await resolveExactWorkspaceById(config.workspacesDir, id);
    if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    const saved = await withResourceAdministrationLock(async () => {
      await validateResourceSelections(body.enabledSkills, body.enabledAgents, wsPath);
      return saveWorkspaceSkillsConfig(
        wsPath,
        {
          enabledSkills: body.enabledSkills,
          enabledAgents: body.enabledAgents,
          enabledCategories: Array.isArray(body.enabledCategories) ? body.enabledCategories : [],
        },
        body.expectedRevision,
      );
    });
    return c.json({ success: true, config: saved });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// ─── Enterprise & Modular Domain Packs ─────────────────────────────────────

// List available enterprise organizations
app.get('/api/enterprise/organizations', (c) => {
  return c.json({ organizations: getAvailableOrganizations() });
});

// Register custom organization conventions
app.post('/api/enterprise/organizations', async (c) => {
  try {
    const body = await c.req.json() as OrganizationConventions;
    if (!body.id || !body.name || !Array.isArray(body.rules)) {
      return c.json({ error: 'id, name, and rules array are required for an organization.' }, 400);
    }
    await saveOrganization(body);
    return c.json({ success: true, organization: getOrganization(body.id) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Unregister custom organization
app.delete('/api/enterprise/organizations/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const deleted = await deleteOrganization(id);
  return c.json({ success: deleted });
});

// List available domain packs
app.get('/api/enterprise/domain-packs', (c) => {
  return c.json({ domainPacks: getAvailableDomainPacks() });
});

// Get a single domain pack by ID
app.get('/api/enterprise/domain-packs/:id', (c) => {
  const id = decodeURIComponent(c.req.param('id')).toLowerCase().trim();
  const pack = getDomainPack(id);
  if (!pack) {
    return c.json({ error: `Domain pack "${id}" not found.` }, 404);
  }
  return c.json({ domainPack: pack });
});

// Register custom domain pack
app.post('/api/enterprise/domain-packs', async (c) => {
  try {
    const body = await c.req.json() as DomainPack;
    if (!body.id || !body.name) {
      return c.json({ error: 'id and name are required for a domain pack.' }, 400);
    }
    const normalizedId = body.id.toLowerCase().trim();
    const tags = Array.isArray(body.tags) && body.tags.length > 0
      ? body.tags
      : [normalizedId, ...body.name.toLowerCase().split(/\s+/).filter(Boolean)];
    const packToRegister: DomainPack = {
      ...body,
      id: normalizedId,
      tags,
      isTemplate: false,
    };
    await saveDomainPack(packToRegister);
    return c.json({ success: true, domainPack: getDomainPack(normalizedId) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Update or customize a domain pack
app.put('/api/enterprise/domain-packs/:id', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id')).toLowerCase().trim();
    const existing = getDomainPack(id);
    if (!existing) {
      return c.json({ error: `Domain pack "${id}" not found.` }, 404);
    }
    const body = await c.req.json() as Partial<DomainPack>;

    const tags = Array.isArray(body.tags)
      ? body.tags
      : (existing.tags ?? [id, ...(body.name || existing.name || id).toLowerCase().split(/\s+/).filter(Boolean)]);

    const updatedPack: DomainPack = {
      id,
      name: body.name ?? existing.name ?? id,
      description: body.description ?? existing.description ?? '',
      categoryType: body.categoryType ?? existing.categoryType ?? 'vertical',
      parent: body.parent !== undefined ? (body.parent ? body.parent.trim() : undefined) : existing.parent,
      organization: body.organization ?? existing.organization,
      tags,
      skills: Array.isArray(body.skills) ? body.skills : existing.skills,
      contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles : existing.contextFiles,
      verifyCommand: body.verifyCommand !== undefined ? (body.verifyCommand ? body.verifyCommand.trim() : undefined) : existing.verifyCommand,
      rules: Array.isArray(body.rules) ? body.rules : existing.rules,
      defaultRepos: Array.isArray(body.defaultRepos) ? body.defaultRepos : existing.defaultRepos,
      microservices: Array.isArray(body.microservices) ? body.microservices : existing.microservices,
      isTemplate: false,
    };

    await saveDomainPack(updatedPack);
    return c.json({ success: true, domainPack: getDomainPack(id) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Unregister custom domain pack
app.delete('/api/enterprise/domain-packs/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id')).toLowerCase().trim();
  const deleted = await deleteDomainPack(id);
  return c.json({ success: deleted });
});

// Auto-match domain packs from specification or description
app.post('/api/enterprise/match-domains', async (c) => {
  try {
    const body = await c.req.json() as { description?: string; repos?: string[] };
    const text = body.description || '';
    const repos = Array.isArray(body.repos) ? body.repos : [];
    const matched = matchDomainPacks(text, repos);
    return c.json({ matched });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Get domain packs & organization conventions for a workspace
app.get('/api/workspace/:id/domain-packs', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const config = await loadConfig();
    const wsPath = await resolveExactWorkspaceById(config.workspacesDir, id);
    if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    const feature = await loadFeatureConfig(wsPath);
    if (!feature) return c.json({ error: 'Failed to load workspace feature.' }, 404);

    const resolved = resolveActiveDomainRules(feature.organizationId, feature.domainPacks ?? []);
    return c.json({
      organizationId: feature.organizationId,
      assignedDomainPackIds: feature.domainPacks ?? [],
      ...resolved,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Assign or update domain packs & organization for a workspace
app.post('/api/workspace/:id/domain-packs', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json() as { organizationId?: string; domainPacks?: string[] };
    const config = await loadConfig();
    const wsPath = await resolveExactWorkspaceById(config.workspacesDir, id);
    if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    const feature = await loadFeatureConfig(wsPath);
    if (!feature) return c.json({ error: 'Failed to load workspace feature.' }, 404);

    if (body.organizationId !== undefined) {
      feature.organizationId = body.organizationId;
    }
    if (Array.isArray(body.domainPacks)) {
      feature.domainPacks = body.domainPacks;
    }

    await saveFeatureConfig(wsPath, feature);
    // Refresh workspace context so AGENTS.md immediately reflects active domain rules
    await refreshWorkspace(wsPath, { force: true }).catch(() => {});

    const resolved = resolveActiveDomainRules(feature.organizationId, feature.domainPacks ?? []);
    return c.json({
      success: true,
      feature,
      ...resolved,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Update workspace specification / PO requirements & adaptively match domain packs
app.post('/api/workspace/:id/update-spec', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json() as { description: string; autoMatchDomains?: boolean };
    if (!body.description || typeof body.description !== 'string') {
      return c.json({ error: 'Description is required.' }, 400);
    }
    const config = await loadConfig();
    const wsPath = await resolveExactWorkspaceById(config.workspacesDir, id);
    if (!wsPath) return c.json({ error: 'Workspace not found.' }, 404);
    const feature = await loadFeatureConfig(wsPath);
    if (!feature) return c.json({ error: 'Failed to load workspace feature.' }, 404);

    feature.description = body.description.trim();

    const newlyMatched: string[] = [];
    if (body.autoMatchDomains !== false) {
      const matchedPacks = matchDomainPacks(feature.description);
      const currentPacks = new Set(feature.domainPacks ?? []);
      for (const pack of matchedPacks) {
        if (!currentPacks.has(pack.id)) {
          currentPacks.add(pack.id);
          newlyMatched.push(pack.id);
        }
      }
      feature.domainPacks = Array.from(currentPacks);
    }

    await saveFeatureConfig(wsPath, feature);
    await refreshWorkspace(wsPath, { force: true }).catch(() => {});

    return c.json({
      success: true,
      feature,
      newlyMatched,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});


// ─── Workrooms: opt-in LAN/VPN collaboration ─────────────────────────────

const WORKROOM_HUMAN_SESSION_COOKIES = [
  'contextspace_workroom_human',
  'nexusflow_workroom_human',
] as const;
const WORKROOM_BOOTSTRAP_TOKEN = randomToken();

function establishWorkroomBootstrap(c: Parameters<typeof setCookie>[0]): void {
  for (const cookieName of WORKROOM_BOOTSTRAP_COOKIES) {
    setCookie(c, cookieName, WORKROOM_BOOTSTRAP_TOKEN, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/workrooms',
    });
  }
}

function hasValidWorkroomBootstrap(c: Parameters<typeof getCookie>[0]): boolean {
  const cookieToken = WORKROOM_BOOTSTRAP_COOKIES
    .map((name) => getCookie(c, name))
    .find((val) => typeof val === 'string' && val);
  const headerToken = WORKROOM_BOOTSTRAP_HEADERS
    .map((header) => c.req.header(header))
    .find((val) => typeof val === 'string' && val);
  return Boolean(cookieToken && headerToken
    && tokenDigest(cookieToken) === tokenDigest(WORKROOM_BOOTSTRAP_TOKEN)
    && tokenDigest(headerToken) === tokenDigest(WORKROOM_BOOTSTRAP_TOKEN));
}

function establishWorkroomHumanSession(c: Parameters<typeof setCookie>[0], token = workroomManager.beginHumanSession()): void {
  for (const cookieName of WORKROOM_HUMAN_SESSION_COOKIES) {
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/workrooms',
    });
  }
}

function getWorkroomHumanSessionToken(c: Parameters<typeof getCookie>[0]): string | undefined {
  return WORKROOM_HUMAN_SESSION_COOKIES
    .map((name) => getCookie(c, name))
    .find((val) => typeof val === 'string' && val);
}

function clearWorkroomHumanSession(c: Parameters<typeof setCookie>[0]): void {
  for (const cookieName of WORKROOM_HUMAN_SESSION_COOKIES) {
    deleteCookie(c, cookieName, { path: '/api/workrooms' });
  }
}

function hasExactDashboardOrigin(origin: string | undefined, requestUrl: string): boolean {
  if (!origin) return false;
  try {
    const normalizedOrigin = new URL(origin).origin;
    const requestOrigin = new URL(requestUrl).origin;
    const devOrigin = process.env.CONTEXTSPACE_DASHBOARD_ORIGIN || process.env.NEXUSFLOW_DASHBOARD_ORIGIN;
    const configuredDevelopmentOrigin = devOrigin ? new URL(devOrigin).origin : undefined;
    return normalizedOrigin === requestOrigin || normalizedOrigin === configuredDevelopmentOrigin;
  } catch {
    return false;
  }
}

function hasExactWorkroomBrowserBoundary(c: Parameters<typeof getCookie>[0]): boolean {
  const origin = c.req.header('origin');
  if (origin) return hasExactDashboardOrigin(origin, c.req.url);
  const referer = c.req.header('referer');
  if (referer) return hasExactDashboardOrigin(referer, c.req.url);
  return c.req.header('sec-fetch-site') === 'same-origin';
}

app.use('/api/workrooms/*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  c.header('Cache-Control', 'no-store');
  if (!hasExactWorkroomBrowserBoundary(c)) {
    return c.json({ error: 'Workroom access requires the local browser dashboard.' }, 403);
  }
  if (pathname === '/api/workrooms/bootstrap') return next();
  if (!hasValidWorkroomBootstrap(c)) {
    return c.json({ error: 'Workroom access requires a same-origin dashboard bootstrap.' }, 403);
  }
  if (pathname === '/api/workrooms/session' || pathname === '/api/workrooms/session/reclaim'
    || pathname === '/api/workrooms/session/abandon') return next();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
  const needsHumanReadSession = c.req.method === 'GET' && (
    pathname === '/api/workrooms/snapshot'
    || pathname === '/api/workrooms/local-resources'
    || (pathname === '/api/workrooms/status' && workroomManager.hasActiveRoom())
  );
  if (!isMutation && !needsHumanReadSession) return next();
  const doesNotRequireExistingHumanSession = pathname === '/api/workrooms/start'
    || pathname === '/api/workrooms/join'
    || pathname === '/api/workrooms/import'
    || /^\/api\/workrooms\/quarantined\/room-[a-f0-9]{32}\/discard$/.test(pathname)
    || /^\/api\/workrooms\/room-[a-f0-9]{32}\/resume$/.test(pathname);
  if (needsHumanReadSession || (isMutation && !doesNotRequireExistingHumanSession)) {
    try {
      const authority = workroomManager.assertHumanSession(getWorkroomHumanSessionToken(c));
      if (pathname === '/api/workrooms/stop') return next();
      await workroomManager.runWithHumanAuthority(authority, () => next());
      return;
    } catch (error) {
      return errorResponse(c, error);
    }
  }
  await next();
});

app.post('/api/workrooms/bootstrap', (c) => {
  establishWorkroomBootstrap(c);
  return c.json({ token: WORKROOM_BOOTSTRAP_TOKEN });
});

app.get('/api/workrooms/session', (c) => {
  const active = workroomManager.hasActiveRoom();
  if (!active) return c.json({ active: false, locked: false });
  const roomType = workroomManager.activeRoomType();
  if (!roomType) return c.json({ active: false, locked: false });
  try {
    workroomManager.assertHumanSession(getWorkroomHumanSessionToken(c));
    return c.json({ active: true, locked: false, roomType });
  } catch {
    return c.json({ active: true, locked: true, roomType });
  }
});

app.post('/api/workrooms/session/reclaim', async (c) => {
  try {
    const body = await c.req.json();
    if (!workroomManager.hasActiveRoom()) return c.json({ error: 'No active Workroom can be reconnected.' }, 409);
    const token = await workroomManager.reclaimHostHumanSession(String(body.password ?? ''));
    establishWorkroomHumanSession(c, token);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/session/abandon', async (c) => {
  try {
    const body = await c.req.json();
    if (body.confirm !== true) return c.json({ error: 'Confirm leaving this locked guest connection.' }, 400);
    await workroomManager.abandonLockedGuest();
    clearWorkroomHumanSession(c);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/interfaces', (c) => {
  return c.json({ interfaces: listWorkroomNetworkInterfaces() });
});

app.get('/api/workrooms/status', async (c) => {
  try {
    const status = await workroomManager.status();
    if (status.mode !== 'idle') {
      workroomManager.assertHumanSession(getWorkroomHumanSessionToken(c));
    }
    return c.json({ status });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/paused', async (c) => {
  try {
    return c.json({ rooms: await workroomManager.listPaused() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/quarantined', async (c) => {
  try {
    return c.json({ rooms: await workroomManager.listQuarantined() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/quarantined/:roomId/discard', async (c) => {
  try {
    const roomId = c.req.param('roomId');
    const body = await c.req.json();
    if (body.confirmRoomId !== roomId) {
      return c.json({ error: 'Confirm the exact quarantined Workroom ID before discarding it.' }, 400);
    }
    await workroomManager.discardQuarantined(roomId);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/:roomId/resume', async (c) => {
  try {
    const body = await c.req.json();
    const status = await workroomManager.resumeHost(c.req.param('roomId'), String(body.password ?? ''));
    establishWorkroomHumanSession(c);
    return c.json({ status });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/preview/:workspaceId', async (c) => {
  try {
    const workspaceId = decodeURIComponent(c.req.param('workspaceId'));
    const config = await loadConfig();
    const workspacePath = await resolveExactWorkspaceById(config.workspacesDir, workspaceId);
    if (!workspacePath) return c.json({ error: 'Workspace not found.' }, 404);
    return c.json({ preview: await buildPortableWorkroomPreview(workspacePath) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/start', async (c) => {
  try {
    const body = await c.req.json();
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    const config = await loadConfig();
    const workspacePath = await resolveExactWorkspaceById(config.workspacesDir, workspaceId);
    if (!workspacePath) return c.json({ error: 'Workspace not found.' }, 404);
    const preview = await buildPortableWorkroomPreview(workspacePath);
    if (body.contextConfirmed !== true) {
      return c.json({ error: 'Review the exact shared context and confirm it before starting the Workroom.' }, 400);
    }
    const documentOverrides = typeof body.documents === 'object' && body.documents !== null
      ? body.documents as Record<string, unknown>
      : {};
    const documents = { plan: '', decisions: '', handoff: '' };
    for (const name of ['plan', 'decisions', 'handoff'] as const) {
      if (typeof documentOverrides[name] === 'string') documents[name] = documentOverrides[name];
    }
    if (body.contextDigest !== digestPortableWorkroomContext(preview.bundle, documents)) {
      return c.json({ error: 'The exact selected context changed after review. Refresh the sharing preview and confirm it again.' }, 409);
    }
    const status = await workroomManager.startHost({
      ...preview,
      documents,
      name: String(body.name ?? '').trim() || `${preview.bundle.feature.id} workroom`,
      address: String(body.address ?? ''),
      port: Number(body.port ?? 4242),
      password: String(body.password ?? ''),
      hostDisplayName: String(body.hostDisplayName ?? '').trim() || os.userInfo().username || 'Host',
    });
    establishWorkroomHumanSession(c);
    return c.json({ status }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/stop', async (c) => {
  try {
    const authority = workroomManager.assertHumanSession(getWorkroomHumanSessionToken(c));
    await workroomManager.stopOrLeave(authority);
    clearWorkroomHumanSession(c);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/invites', async (c) => {
  try {
    return c.json(await workroomManager.createInvite(), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/join', async (c) => {
  try {
    const body = await c.req.json();
    let localWorkspaceId: string | undefined;
    if (typeof body.workspaceId === 'string' && body.workspaceId) {
      const config = await loadConfig();
      const workspacePath = await resolveExactWorkspaceById(config.workspacesDir, body.workspaceId);
      if (!workspacePath) return c.json({ error: 'Select an existing local workspace for the Workroom mapping.' }, 404);
      localWorkspaceId = body.workspaceId;
    }
    const status = await workroomManager.join(
      String(body.invite ?? ''),
      String(body.password ?? ''),
      String(body.displayName ?? '').trim() || os.userInfo().username || 'Developer',
      localWorkspaceId,
    );
    establishWorkroomHumanSession(c);
    return c.json({ status }, 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/join/poll', async (c) => {
  try {
    return c.json({ status: await workroomManager.pollJoin() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/snapshot', async (c) => {
  try {
    return c.json({ snapshot: await workroomManager.snapshot() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put('/api/workrooms/documents/:name', async (c) => {
  try {
    const name = documentNameSchema.parse(c.req.param('name'));
    const body = await c.req.json();
    if (typeof body.content !== 'string' || !Number.isInteger(body.expectedRevision)) {
      return c.json({ error: 'content and an integer expectedRevision are required.' }, 400);
    }
    return c.json({ document: await workroomManager.updateDocument(name, body.content, body.expectedRevision) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/handoff', async (c) => {
  try {
    const body = await c.req.json();
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    const config = await loadConfig();
    const workspacePath = await resolveExactWorkspaceById(config.workspacesDir, workspaceId);
    if (!workspacePath) return c.json({ error: 'Select a local workspace before publishing a handoff.' }, 404);
    return c.json({ document: await workroomManager.publishHandoff(workspacePath) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/members/:requestId/decision', async (c) => {
  try {
    const body = await c.req.json();
    if (typeof body.accept !== 'boolean') return c.json({ error: 'accept must be a boolean.' }, 400);
    await workroomManager.decideJoin(c.req.param('requestId'), body.accept);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put('/api/workrooms/members/:memberId/role', async (c) => {
  try {
    const body = await c.req.json();
    if (body.role !== 'publisher' && body.role !== 'member') return c.json({ error: 'role must be publisher or member.' }, 400);
    await workroomManager.setRole(c.req.param('memberId'), body.role);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete('/api/workrooms/members/:memberId', async (c) => {
  try {
    await workroomManager.revokeMember(c.req.param('memberId'));
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/password/rotate', async (c) => {
  try {
    const body = await c.req.json();
    await workroomManager.rotatePassword(String(body.password ?? ''), body.revokeDevices !== false);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/api/workrooms/local-resources', async (c) => {
  try {
    return c.json({ resources: await workroomManager.listLocalResources() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/resources/publish', async (c) => {
  try {
    const body = await c.req.json();
    if (!['skill', 'agent', 'workflow'].includes(body.kind) || typeof body.id !== 'string' || typeof body.version !== 'string') {
      return c.json({ error: 'kind, id, and semantic version are required.' }, 400);
    }
    return c.json({ package: await workroomManager.publishLocalResource(body.kind, body.id, body.version) }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/resources/:digest/download', async (c) => {
  try {
    return c.json(await workroomManager.downloadResource(c.req.param('digest')));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/resources/:digest/apply', async (c) => {
  try {
    const body = await c.req.json();
    return c.json({ applied: await workroomManager.applyResource(
      c.req.param('digest'),
      String(body.approvedDigest ?? ''),
      String(body.approvedLocalDigest ?? ''),
    ) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/resources/:digest/quarantine', async (c) => {
  try {
    await workroomManager.quarantineResource(c.req.param('digest'));
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/resources/:digest/purge', async (c) => {
  try {
    const body = await c.req.json();
    if (body.confirmDigest !== c.req.param('digest')) {
      return c.json({ error: 'Confirm the exact quarantined resource digest before purging it.' }, 400);
    }
    await workroomManager.purgeResource(c.req.param('digest'));
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/workflow/select', async (c) => {
  try {
    const body = await c.req.json();
    const steps = Array.isArray(body.steps)
      ? body.steps.map((step: unknown) => workflowStepSchema.parse(step))
      : undefined;
    if (typeof body.workflowId !== 'string' || typeof body.version !== 'string' || !steps
      || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      return c.json({ error: 'workflowId, version, steps, and a nonnegative integer expectedRevision are required.' }, 400);
    }
    await workroomManager.selectLocalWorkflow(body.workflowId, body.version, steps, body.expectedRevision);
    return c.json({ success: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/workflow/steps/:stepId/transition', async (c) => {
  try {
    const body = await c.req.json();
    const allowed = ['pending', 'in_progress', 'completion_proposed', 'completed', 'skipped'];
    if (!allowed.includes(body.status) || !Number.isInteger(body.expectedRevision)) {
      return c.json({ error: 'A valid status and integer expectedRevision are required.' }, 400);
    }
    return c.json({ step: await workroomManager.transitionWorkflowStep(
      c.req.param('stepId'),
      body.status,
      body.expectedRevision,
      typeof body.evidence === 'string' ? body.evidence : undefined,
    ) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/export', async (c) => {
  try {
    const body = await c.req.json();
    return c.json({ export: await workroomManager.exportRoom(String(body.passphrase ?? '')) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/api/workrooms/import', async (c) => {
  try {
    const body = await c.req.json();
    const status = await workroomManager.importRoom(body.export, String(body.exportPassphrase ?? ''), {
      name: typeof body.name === 'string' ? body.name : undefined,
      address: String(body.address ?? ''),
      port: Number(body.port ?? 4242),
      password: String(body.password ?? ''),
      hostDisplayName: String(body.hostDisplayName ?? '').trim() || os.userInfo().username || 'Host',
    });
    establishWorkroomHumanSession(c);
    return c.json({ status }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});


// ─── Schedules: recurring workspace jobs (sync/refresh) ─────────────────


// List all scheduled jobs (with computed next-due time)
app.get('/api/schedules', async (c) => {
  const store = await loadSchedules();
  const jobs = store.jobs.map((job) => ({
    ...job,
    nextDueAt: nextDueAt(job)?.toISOString() ?? null,
  }));
  return c.json({ jobs });
});

// Create a scheduled job
app.post('/api/schedules', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const task = body.task === 'refresh' ? 'refresh' : body.task === 'sync' ? 'sync' : null;
  if (!task) {
    return c.json({ error: 'task must be "sync" or "refresh"' }, 400);
  }

  const intervalMinutes =
    typeof body.intervalMinutes === 'number' && body.intervalMinutes > 0
      ? Math.floor(body.intervalMinutes)
      : parseInterval(String(body.every ?? ''));
  if (!intervalMinutes) {
    return c.json({ error: 'Provide intervalMinutes (> 0) or every (e.g. "30m", "2h", "1d")' }, 400);
  }

  const config = await loadConfig();
  const workspacePath = body.workspacePath
    ? String(body.workspacePath)
    : body.workspaceId
      ? path.join(config.workspacesDir, String(body.workspaceId))
      : null;
  if (!workspacePath) {
    return c.json({ error: 'Provide workspacePath or workspaceId' }, 400);
  }

  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    return c.json({ error: `No NexusFlow workspace found at ${workspacePath}` }, 404);
  }

  const job = await addSchedule({ workspacePath, task, intervalMinutes });
  return c.json({ job }, 201);
});

// Enable/disable a scheduled job
app.post('/api/schedules/:id/enabled', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const job = await setScheduleEnabled(c.req.param('id'), Boolean(body.enabled));
  if (!job) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ job });
});

// Run a scheduled job immediately
app.post('/api/schedules/:id/run', async (c) => {
  const store = await loadSchedules();
  const job = store.jobs.find((j) => j.id === c.req.param('id'));
  if (!job) return c.json({ error: 'Schedule not found' }, 404);
  const result = await runJob(job);
  return c.json({ result });
});

// Delete a scheduled job
app.delete('/api/schedules/:id', async (c) => {
  const removed = await removeSchedule(c.req.param('id'));
  if (!removed) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ ok: true });
});

// Refresh a workspace's context files on demand (cache-aware)
app.post('/api/workspace/:id/refresh', async (c) => {
  try {
    const config = await loadConfig();
    const workspacePath = resolveWorkspacePath(config.workspacesDir, c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const report = await refreshWorkspace(workspacePath, { force: Boolean(body.force), check: Boolean(body.check) });
    return c.json({ report });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Legacy pack endpoint removed.

// Serve index.html explicitly on root endpoint
app.get('/', async (c) => {
  try {
    const html = await fs.readFile(path.join(guiPath, 'index.html'), 'utf-8');
    return c.html(html);
  } catch (error) {
    return c.text('GUI dashboard built assets not found. Run "npm run build" first.', 404);
  }
});

// Serve static assets from GUI build folder. Use the absolute build path
// (serveStatic joins root + request path) so asset serving does not depend on
// the server's cwd — a cwd on another drive made the old cwd-relative path
// resolve wrong and serve a blank GUI, e.g. under `ui --daemon`.
app.use('/*', serveStatic({ root: guiPath }));

// A link that leaves the app (for example a local file path clicked in a
// rendered document) must not strand the user on a bare 404 with no way back:
// page loads that match no route or asset get a page that returns to the app.
// API and asset requests keep the plain 404.
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/') || !(c.req.header('accept') ?? '').includes('text/html')) return c.notFound();
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · ${BRAND_NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937;background:#fff}@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#111827}a{color:#93c5fd}}</style></head>
<body><h1>This page isn't part of ${BRAND_NAME}</h1><p>The link you followed points to a file or page the app can't show here.</p><p><a href="/">Back to ${BRAND_NAME}</a></p></body></html>`, 404);
});

export function startServer(
  port = 3000,
  opts: { strictPort?: boolean } = {},
): Promise<{ port: number; server: any }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
      // The dashboard server doubles as the host for recurring workspace
      // jobs (nexusflow schedule ...); jobs are re-read from disk each tick.
      startScheduler({ log: (message) => console.log(`[scheduler] ${message}`) });
      resolve({ port: info.port, server });
    }) as import('node:http').Server;

    injectWebSocket(server);
    const stopTerminals = () => { terminalManager.dispose(); process.exit(0); };
    process.once('SIGTERM', stopTerminals);
    process.once('SIGINT', stopTerminals);
    server.once('close', () => {
      process.removeListener('SIGTERM', stopTerminals);
      process.removeListener('SIGINT', stopTerminals);
    });

    server.on('close', () => {
      terminalManager.dispose();
      void workroomManager.stopOrLeave().catch((error) => {
        console.error('[workroom] failed to stop with the dashboard:', error instanceof Error ? error.message : String(error));
      });
    });

    server.on('error', (e: any) => {
      if (e.code === 'EADDRINUSE') {
        // Callers that own their backend (desktop/extension) pass strictPort so
        // they can rely on the port they requested instead of chasing a silent
        // increment they'd never find.
        if (opts.strictPort) {
          reject(new Error(`Port ${port} is already in use.`));
        } else {
          resolve(startServer(port + 1, opts));
        }
      } else {
        reject(e);
      }
    });
  });
}
