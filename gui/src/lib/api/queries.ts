import { floatingChatStore } from '../../features/chat/floatingChatStore.js';
/**
 * TanStack Query hooks for the NexusFlow API. One hook per endpoint group;
 * mutations invalidate the queries they affect so screens stay fresh without
 * hand-rolled refetch effects.
 */

import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiFetch } from './client.js';
import type {
  AISession,
  DetectedAI,
  DetectedEditor,
  Feature,
  ContextSpaceConfig,
  DomainPack,
  OrchestrationDetection,
  Project,
  RepoInfo,
  RunningOrchestrator,
  RunningService,
  ServiceConfig,
  ServiceFailure,
  ProcfileSuggestion,
  SkillCategory,
  SkillDiagnosticItem,
  SkillItem,
  CodexAgentItem,
  WorkspaceSkillsConfig,
  WorkspaceMode,
  WorkspaceLaunchTarget,
  WorkspaceStatus,
  WorkspaceStreamMessage,
  WorkspaceStreamResponse,
  InputRequest,
  RepoFreshness,
  FastForwardResult,
  WorkspaceLifecycle,
  WorkspaceVerificationReport,
  WorkspaceRepository,
  ProgressionDecision,
  FinishRecord,
  WorkGuidance,
  ProgressFacts,
  RepoChangeListing,
  WorkspaceBackupStatus,
} from '../../types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Shape of GET /api/config — the config is wrapped, not top-level. */
export interface ConfigResponse {
  exists: boolean;
  config: ContextSpaceConfig;
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => apiFetch<ConfigResponse>('/api/config', { signal }),
  });
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: ({ signal }) => apiFetch<Feature[]>('/api/workspaces', { signal }),
  });
}

export interface WorkspaceStatusPage {
  statuses: Record<string, WorkspaceStatus>;
  total: number;
  nextOffset: number | null;
  snapshot: string;
}

/** Check workspace Git status in bounded batches so the shell can render early. */
export function useWorkspacesStatus(options: { enabled?: boolean; intervalMs?: number | false } = {}) {
  return useInfiniteQuery({
    queryKey: ['workspaces-status'],
    queryFn: ({ pageParam, signal }) => apiFetch<WorkspaceStatusPage>(`/api/workspaces/status?offset=${pageParam.offset}&limit=24${pageParam.snapshot ? `&snapshot=${encodeURIComponent(pageParam.snapshot)}` : ''}`, { signal }),
    initialPageParam: { offset: 0, snapshot: '' },
    getNextPageParam: (page) => page.nextOffset === null ? undefined : { offset: page.nextOffset, snapshot: page.snapshot },
    enabled: options.enabled ?? true,
    refetchInterval: options.intervalMs ?? false,
  });
}

export interface CreateWorkspacePayload {
  flowType?: 'quick' | 'feature' | 'epic';
  workType?: 'bug' | 'feature' | 'performance' | 'refactor' | 'rewrite';
  mode?: WorkspaceMode;
  projectId?: string;
  /** Human-readable workspace name; also used for the in-place workspace id. */
  name?: string;
  branchName?: string;
  description?: string;
  repos: Array<{ name: string; path: string; defaultBranch: string; existingBranch?: string }>;
  assistants: string[];
  teamworkInstructions?: string;
  autoUpdateBase?: boolean;
  enabledSkills?: string[];
  enabledAgents?: string[];
  enabledCategories?: string[];
  domainPacks?: string[];
  organizationId?: string;
}

export function useDomainPacks() {
  return useQuery({
    queryKey: ['domain-packs'],
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ domainPacks: DomainPack[] }>('/api/enterprise/domain-packs', { signal });
      return res?.domainPacks ?? [];
    },
  });
}

export function useCreateDomainPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pack: DomainPack) =>
      apiFetch<{ success: boolean; domainPack: DomainPack }>('/api/enterprise/domain-packs', {
        method: 'POST',
        body: JSON.stringify(pack),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domain-packs'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-domain-packs'] });
    },
  });
}

export function useSaveDomainPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pack: Partial<DomainPack> & { id: string; name: string }) =>
      apiFetch<{ success: boolean; domainPack: DomainPack }>(`/api/enterprise/domain-packs/${encodeURIComponent(pack.id)}`, {
        method: 'PUT',
        body: JSON.stringify(pack),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domain-packs'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-domain-packs'] });
    },
  });
}

export function useDeleteDomainPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/enterprise/domain-packs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domain-packs'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-domain-packs'] });
    },
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWorkspacePayload) =>
      apiFetch<{ success: boolean; jobId: string }>('/api/workspace', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces-status'] });
    },
  });
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => apiFetch<Project[]>('/api/projects', { signal }),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; repos: string[]; description?: string }) =>
      apiFetch<Project>('/api/projects', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: string; name?: string; repos?: string[]; description?: string | null }) =>
      apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}

// ─── Repos & detection ────────────────────────────────────────────────────────

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: ({ signal }) => apiFetch<RepoInfo[]>('/api/repos', { signal }),
  });
}

/** Local and origin branches of a repository (mirrors utils/git.ts). */
export interface RepoBranches {
  local: string[];
  remote: string[];
}

/** Branches of one repo, for existing-branch suggestions. Lazy via `enabled`. */
export function useRepoBranches(repoPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ['repo-branches', repoPath],
    queryFn: ({ signal }) => apiFetch<RepoBranches>(`/api/repos/branches?path=${encodeURIComponent(repoPath)}`, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/** Freshness of a single repository branch. */
export function useRepoFreshness(repoPath: string, branch?: string, enabled = true) {
  return useQuery({
    queryKey: ['repo-freshness', repoPath, branch],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ path: repoPath });
      if (branch) q.set('branch', branch);
      return apiFetch<RepoFreshness>(`/api/repos/freshness?${q.toString()}`, { signal });
    },
    enabled: enabled && !!repoPath,
    staleTime: 30_000,
  });
}

/** Freshness for a batch of repositories. */
export function useReposFreshness(repos: Array<{ path: string; branch?: string }>, enabled = true) {
  return useQuery({
    queryKey: ['repos-freshness', repos],
    queryFn: ({ signal }) =>
      apiFetch<RepoFreshness[]>('/api/repos/freshness', {
        signal,
        method: 'POST',
        body: JSON.stringify({ repos }),
      }),
    enabled: enabled && repos.length > 0,
    staleTime: 30_000,
  });
}

/** Pulls and fast-forwards base repository branches to remote tracking. */
export function usePullRepos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { path?: string; branch?: string; repos?: Array<{ path: string; branch?: string }> }) =>
      apiFetch<{ success: boolean; results: FastForwardResult[] }>('/api/repos/pull', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repo-freshness'] });
      queryClient.invalidateQueries({ queryKey: ['repos-freshness'] });
    },
  });
}

/** Scaffolds a brand-new local git repository in the dev directory. */
export function useCreateRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ success: boolean; repo: RepoInfo }>('/api/repos/new', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useAiDetect() {
  return useQuery({
    queryKey: ['ai-detect'],
    queryFn: ({ signal }) => apiFetch<DetectedAI[]>('/api/ai-detect', { signal }),
    staleTime: 60_000,
  });
}

export function useEditorDetect() {
  return useQuery({
    queryKey: ['editor-detect'],
    queryFn: ({ signal }) => apiFetch<DetectedEditor[]>('/api/editor-detect', { signal }),
    staleTime: 60_000,
  });
}

export function useWorkspaceLaunchTargets() {
  return useQuery({
    queryKey: ['workspace-launch-targets'],
    queryFn: ({ signal }) => apiFetch<WorkspaceLaunchTarget[]>('/api/workspace-launch-targets', { signal }),
    staleTime: 60_000,
  });
}

export function useWorkspaceRecentSessions(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['workspace-recent-sessions', workspaceId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ limit: '3', desktopHandoffOnly: 'true' });
      const data = await apiFetch<{ sessions: AISession[] }>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/sessions?${params}`, { signal },
      );
      return data.sessions;
    },
    enabled,
    staleTime: 30_000,
  });
}

// ─── Workflow strategy templates ──────────────────────────────────────────────

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  custom: boolean;
}

export function useWorkflowTemplates() {
  return useQuery({
    queryKey: ['workflow-templates'],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<{ templates: WorkflowTemplate[] }>('/api/workflows/templates', { signal });
      return data.templates;
    },
  });
}

// ─── Services & orchestration ─────────────────────────────────────────────────

export interface WorkspaceServicesResponse {
  services: ServiceConfig[];
  orchestrationTools: OrchestrationDetection[];
  runningState: RunningService[];
  runningOrchestrators: RunningOrchestrator[];
  /** Why services did not start or stopped unexpectedly (older servers omit it). */
  failures?: ServiceFailure[];
  /** Procfile.dev suggestions when nothing is declared (older servers omit it). */
  suggestions?: ProcfileSuggestion[];
}

/** Detected services + running state for a workspace, polled while displayed. */
export function useWorkspaceServices(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-services', wsId],
    queryFn: ({ signal }) => apiFetch<WorkspaceServicesResponse>(`/api/workspace/${encodeURIComponent(wsId!)}/services`, { signal }),
    enabled: !!wsId,
    refetchInterval: 3000,
    retry: 1,
  });
}

type ServiceAction = 'start' | 'stop' | 'restart';

/**
 * Start/stop/restart a single service, or (with no `service`) all services.
 * The server re-detects configs — no command is ever sent from the client.
 */
export function useServiceAction(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, service }: { action: ServiceAction; service?: string }) => {
      const base = `/api/workspace/${encodeURIComponent(wsId)}/services`;
      const path = service
        ? `${base}/${encodeURIComponent(service)}/${action}`
        : `${base}/${action}`; // bulk start/stop only
      return apiFetch<{ success: boolean }>(path, { method: 'POST' });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-services', wsId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces-status'] });
    },
  });
}

/** Start/stop a detected orchestration tool by its detection id. */
export function useOrchestratorAction(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id }: { action: 'start' | 'stop'; id: string }) =>
      apiFetch<{ success: boolean }>(`/api/workspace/${encodeURIComponent(wsId)}/orchestrators/${action}`, {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-services', wsId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces-status'] });
    },
  });
}

// ─── Skills & Categories ──────────────────────────────────────────────────

export type { SkillCategory, SkillItem, CodexAgentItem, WorkspaceSkillsConfig } from '../../types.js';

export function useSkillCategories() {
  return useQuery({
    queryKey: ['skill-categories'],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<{ categories: SkillCategory[] }>('/api/skills/categories', { signal });
      return data.categories;
    },
  });
}

export function useSaveSkillCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (category: Partial<SkillCategory> & { name: string }) =>
      apiFetch<{ success: boolean; category: SkillCategory }>('/api/skills/categories', {
        method: 'POST',
        body: JSON.stringify(category),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-categories'] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export function useDeleteSkillCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/skills/categories/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-categories'] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

function skillCatalogOptions(workspaceId?: string) {
  return {
    queryKey: ['skills', workspaceId],
    queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<{ skills: SkillItem[]; diagnostics?: SkillDiagnosticItem[] }>(workspaceId ? `/api/skills?workspace=${encodeURIComponent(workspaceId)}` : '/api/skills', { signal }),
  };
}

/** Skills that did not load or need attention. No workspace id means the global catalog. */
export function useSkillDiagnostics(workspaceId?: string) {
  return useQuery({ ...skillCatalogOptions(workspaceId), select: (data) => data.diagnostics ?? [] });
}

export function useSkills(workspaceId?: string) {
  return useQuery({ ...skillCatalogOptions(workspaceId), select: (data) => data.skills });
}

export function useSaveSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skill: Partial<SkillItem> & { name: string; content: string; workspaceId?: string; workspace?: string; scope?: 'global' | 'workspace' }) =>
      apiFetch<{ success: boolean; skill: SkillItem }>('/api/skills', {
        method: 'POST',
        body: JSON.stringify(skill),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill-categories'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (arg: string | { id: string; workspaceId?: string }) => {
      const id = typeof arg === 'string' ? arg : arg.id;
      const ws = typeof arg === 'string' ? undefined : arg.workspaceId;
      const url = ws
        ? `/api/skills/${encodeURIComponent(id)}?workspace=${encodeURIComponent(ws)}`
        : `/api/skills/${encodeURIComponent(id)}`;
      return apiFetch<{ success: boolean }>(url, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-skills'] });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['codex-agents'],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<{ agents: CodexAgentItem[] }>('/api/agents', { signal });
      return data.agents;
    },
  });
}

export function useSaveAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agent: Omit<CodexAgentItem, 'custom' | 'sourcePath'>) =>
      apiFetch<{ success: boolean; agent: CodexAgentItem }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(agent),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['codex-agents'] }),
  });
}

export function useImportAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ toml, category }: { toml: string; category?: string }) =>
      apiFetch<{ success: boolean; agent: CodexAgentItem }>('/api/agents/import', {
        method: 'POST',
        body: JSON.stringify({ toml, category }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['codex-agents'] }),
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['codex-agents'] }),
  });
}

export function useWorkspaceSkills(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-skills', wsId],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<{ config: WorkspaceSkillsConfig }>(`/api/skills/workspace/${encodeURIComponent(wsId!)}`, { signal });
      return data.config;
    },
    enabled: !!wsId,
  });
}

export function useAssignWorkspaceSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, expectedRevision, ...config }: WorkspaceSkillsConfig & { workspaceId: string; expectedRevision?: number }) =>
      apiFetch<{ success: boolean; config: WorkspaceSkillsConfig }>(`/api/skills/workspace/${encodeURIComponent(workspaceId)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ ...config, expectedRevision }),
      }),
    onSuccess: (data, variables) => {
      queryClient.setQueryData(['workspace-skills', variables.workspaceId], data.config);
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

export interface LaunchTerminalPayload {
  workspaceId: string;
  command?: string;
  assistant?: string;
  sessionId?: string;
  title?: string;
  cwd?: string;
}

export function useLaunchTerminal() {
  return useMutation({
    mutationFn: async ({ workspaceId, ...payload }: LaunchTerminalPayload) => {
      if (payload.assistant) {
        floatingChatStore.openTerminal(workspaceId, payload.assistant, payload.sessionId, payload.cwd);
        return { success: true, command: payload.assistant };
      }
      return apiFetch<{ success: boolean; command: string }>(`/api/workspace/${encodeURIComponent(workspaceId)}/terminal`, {
        method: 'POST', body: JSON.stringify(payload),
      });
    },
  });
}

export function useRefreshWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, force }: { workspaceId: string; force?: boolean }) =>
      apiFetch<{ report: unknown }>(`/api/workspace/${encodeURIComponent(workspaceId)}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-skills', variables.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['skills', variables.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces-status'] });
    },
  });
}

export function useWorkspaceStream(workspaceId: string | null, options: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: ['workspace-stream', workspaceId],
    queryFn: ({ signal }) => apiFetch<WorkspaceStreamResponse>(`/api/workspace/${encodeURIComponent(workspaceId!)}/stream`, { signal }),
    enabled: Boolean(workspaceId),
    refetchInterval: options.refetchInterval ?? 3000,
  });
}

/**
 * The newest "agent needs input" request in each named workspace (the open CLI
 * chats). Polls even when the window is in the background, because being away
 * is exactly when the user needs the alert.
 */
export function useInputRequests(workspaceIds: readonly string[]) {
  const ids = [...new Set(workspaceIds)].sort();
  return useQuery({
    queryKey: ['input-requests', ids],
    queryFn: async () => {
      const { requests } = await apiFetch<{ requests: InputRequest[] }>(
        `/api/attention?workspaces=${encodeURIComponent(ids.join(','))}`,
      );
      return requests;
    },
    enabled: ids.length > 0,
    refetchInterval: 4000,
    refetchIntervalInBackground: true,
    // Opening or closing a tab changes the key. Keep showing the last answer until
    // the new one arrives, or the indicators would blink off for a poll.
    placeholderData: keepPreviousData,
  });
}

export function usePostWorkspaceStream(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      message: string;
      harness?: string;
      author?: string;
      status?: string;
      stepId?: string;
      evidence?: string;
    }) =>
      apiFetch<{ success: boolean; entry: WorkspaceStreamMessage }>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/stream`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-stream', workspaceId] });
    },
  });
}

// ─── Lifecycle & Planning ───────────────────────────────────────────────────

export interface WorkspaceLifecycleResponse {
  lifecycle: WorkspaceLifecycle;
  report?: WorkspaceVerificationReport | null;
  plan?: string;
}

export function useWorkspaceLifecycle(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-lifecycle', wsId],
    queryFn: async ({ signal }) => {
      const data = await apiFetch<WorkspaceLifecycleResponse>(
        `/api/workspace/${encodeURIComponent(wsId!)}/lifecycle`, { signal }
      );
      return data;
    },
    enabled: Boolean(wsId),
    staleTime: 10_000,
  });
}

/** The workspace's current AI assignment (stage, objective) and documents. */
export function useWorkGuidance(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-work', wsId],
    queryFn: async ({ signal }) => (await apiFetch<{ guidance: WorkGuidance }>(`/api/workspace/${encodeURIComponent(wsId!)}/work`, { signal })).guidance,
    enabled: Boolean(wsId),
    staleTime: 10_000,
  });
}

// ─── Backup status (would the hand-written notes survive losing this computer) ──

/**
 * Read-only. The server has no route that adds a remote or pushes, so the notice built on this
 * only shows the commands to run; it cannot run them.
 */
export function useWorkspaceBackup(workspaceId: string) {
  return useQuery({
    queryKey: ['workspace-backup', workspaceId],
    queryFn: ({ signal }) =>
      apiFetch<{ backup: WorkspaceBackupStatus }>(`/api/workspace/${encodeURIComponent(workspaceId)}/backup`, { signal }),
    select: (data) => data.backup,
    staleTime: 60_000,
    retry: false,
  });
}

// ─── Progress facts (the Where Are We strip) ──────────────────────────────

export const progressFactsKey = (wsId: string | null) => ['progress-facts', wsId] as const;

const fetchProgressFacts = async (wsId: string, signal?: AbortSignal) =>
  (await apiFetch<{ facts: ProgressFacts }>(`/api/workspace/${encodeURIComponent(wsId)}/progress-facts`, { signal })).facts;

/**
 * Checkable progress facts: milestones (with reopened work), open questions, changed
 * files and the last check. Polled only while the workspace is on screen; the live
 * feed asks for a fresh read the moment something changes.
 */
export function useProgressFacts(wsId: string | null, active: boolean) {
  return useQuery({
    queryKey: progressFactsKey(wsId),
    queryFn: ({ signal }) => fetchProgressFacts(wsId!, signal),
    enabled: Boolean(wsId) && active,
    refetchInterval: 8000,
    staleTime: 3000,
    // The strip is on screen all the time, so a failure is reported after one quick retry rather than after three slow ones.
    retry: 1,
    retryDelay: 1000,
  });
}

/**
 * The facts and the goal of every open chat, for the tabs and the chat list. The strip polls the chat on screen every
 * eight seconds; these are the others, read slowly and only while the chat is on screen, because a progress read looks
 * at every repository. Both use the strip's own cache keys, so the chat on screen is never read twice.
 */
export function useOpenChatFacts(workspaceIds: readonly string[], enabled: boolean) {
  const facts = useQueries({
    queries: workspaceIds.map((wsId) => ({
      queryKey: progressFactsKey(wsId),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchProgressFacts(wsId, signal),
      enabled,
      refetchInterval: 30_000,
      staleTime: 10_000,
      retry: 1,
    })),
  });
  const guidance = useQueries({
    queries: workspaceIds.map((wsId) => ({
      queryKey: ['workspace-work', wsId],
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await apiFetch<{ guidance: WorkGuidance }>(`/api/workspace/${encodeURIComponent(wsId)}/work`, { signal })).guidance,
      enabled,
      staleTime: 60_000,
      retry: 1,
    })),
  });
  return {
    facts: new Map(workspaceIds.map((wsId, index) => [wsId, facts[index]?.data] as const)),
    guidance: new Map(workspaceIds.map((wsId, index) => [wsId, guidance[index]?.data] as const)),
  };
}

/** The files changed in each repository, for the strip's Touched list. Fetched only while the panel is open. */
export function useWorkspaceChanges(wsId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['workspace-changes-list', wsId],
    queryFn: async ({ signal }) => (await apiFetch<{ changes: RepoChangeListing[] }>(`/api/workspace/${encodeURIComponent(wsId!)}/changes`, { signal })).changes,
    enabled: Boolean(wsId) && enabled,
    staleTime: 5000,
  });
}

/** Sends a finished milestone back for rework. This is the developer's own action, so it is recorded as theirs. */
export function useReopenMilestone(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { stepId: string; reason: string }) => apiFetch<{ lifecycle: WorkspaceLifecycle }>(
      `/api/workspace/${encodeURIComponent(wsId)}/lifecycle/reopen`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: progressFactsKey(wsId) });
      void queryClient.invalidateQueries({ queryKey: ['workspace-lifecycle', wsId] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-work', wsId] });
    },
  });
}

/** Marks every question the AI has asked so far as answered. Replies typed into the chat never reach the ledger. */
export function useAcknowledgeQuestions(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<unknown>(`/api/workspace/${encodeURIComponent(wsId)}/input-requests/acknowledge`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: progressFactsKey(wsId) });
      void queryClient.invalidateQueries({ queryKey: ['input-requests'] });
    },
  });
}

// ─── Repository safety & delivery ─────────────────────────────────────────

/**
 * Live per-repo state: edit boundary, branch, HEAD and changed files. Re-read every 30 seconds while the
 * window is visible (TanStack pauses it in a hidden tab), so a folder switched to another branch from a
 * terminal or an editor is flagged soon after, not only when the window next gets focus.
 */
export const WORKSPACE_REPOSITORIES_POLL_MS = 30_000;

export function useWorkspaceRepositories(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-repositories', wsId],
    queryFn: async ({ signal }) => (await apiFetch<{ repositories: WorkspaceRepository[] }>(
      `/api/workspace/${encodeURIComponent(wsId!)}/repositories`, { signal },
    )).repositories,
    enabled: Boolean(wsId),
    refetchInterval: WORKSPACE_REPOSITORIES_POLL_MS,
  });
}

/** The shared finish policy decision for the current content. */
export function useProgression(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-progression', wsId],
    queryFn: ({ signal }) => apiFetch<ProgressionDecision>(`/api/workspace/${encodeURIComponent(wsId!)}/progression`, { signal }),
    enabled: Boolean(wsId),
  });
}

/** The durable record of the latest finish run, to resume after a restart. */
export function useLastFinish(wsId: string | null) {
  return useQuery({
    queryKey: ['workspace-finish-last', wsId],
    queryFn: async ({ signal }) => (await apiFetch<{ lastFinish: FinishRecord | null }>(
      `/api/workspace/${encodeURIComponent(wsId!)}/finish/last`, { signal },
    )).lastFinish,
    enabled: Boolean(wsId),
  });
}

/**
 * Invalidates every view derived from a workspace's repositories, verification
 * or delivery, so one mutation updates all visible surfaces together.
 */
export function invalidateDeliveryState(queryClient: QueryClient, wsId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['workspace-repositories', wsId] }),
    queryClient.invalidateQueries({ queryKey: ['workspace-progression', wsId] }),
    queryClient.invalidateQueries({ queryKey: ['workspace-finish-last', wsId] }),
    queryClient.invalidateQueries({ queryKey: ['workspace-lifecycle', wsId] }),
    queryClient.invalidateQueries({ queryKey: ['workspaces-status'] }),
    queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  ]);
}
