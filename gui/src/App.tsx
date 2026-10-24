import { lazy, Suspense, useState, useEffect, useRef, useMemo } from 'react';
import {
  AlertTriangle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppSidebar } from './app/AppSidebar.js';
import { defaultWorkspaceTarget } from './app/workspaceList.js';
import { ToastStack, type Toast } from './app/ToastStack.js';
import { VsCodeShell } from './app/VsCodeShell.js';
import { SetupPage } from './features/setup/SetupPage.js';
import { folderErrors, saveConfig as postConfig, type ConfigPathsReport } from './features/setup/setupApi.js';
import { TranscriptDialog } from './features/sessions/TranscriptDialog.js';
import { ChatDock } from './features/chat/ChatDock.js';
import { floatingChatStore } from './features/chat/floatingChatStore.js';
import { RUNNING_TERMINALS_KEY } from './features/chat/useRunningTerminals.js';
import { endWorkspaceSession } from './features/workspace-shell/endWorkspaceSession.js';
import { useDropArchivedTabs } from './app/useDropArchivedTabs.js';
import { ChatHome } from './features/chat/ChatHome.js';
import { ChatAttentionCards } from './features/chat/ChatAttentionCards.js';
import { DeleteWorkspaceDialog } from './components/DeleteWorkspaceDialog.js';
import { ArchiveWorkspaceDialog } from './components/ArchiveWorkspaceDialog.js';
import { Spinner } from './components/ui/spinner.js';
import { safeCopyToClipboard } from './lib/clipboard.js';
import { cn } from './lib/utils.js';
import { toErrorMessage } from './lib/errors.js';
import { perfMark, perfMarkOnce } from './lib/perfMarks.js';
import { changesFromResponse } from './features/changes/utils/changesResponse.js';
import { parseSection, type WorkspaceSection } from './features/workspace-shell/destinations.js';
import { useWorkspaceShortcuts } from './features/workspace-shell/useWorkspaceShortcuts.js';

// Route-level code splitting: each page (and its dependency subtree, e.g. the
// markdown pipeline under WorkspacesPage) loads on first navigation instead of
// inflating the initial bundle.
const DashboardPage = lazy(() => import('./pages/DashboardPage.js').then((m) => ({ default: m.DashboardPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage.js').then((m) => ({ default: m.ProjectsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const SkillsPage = lazy(() => import('./pages/SkillsPage.js').then((m) => ({ default: m.SkillsPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage.js').then((m) => ({ default: m.AgentsPage })));
const WorkroomsPage = lazy(() => import('./pages/WorkroomsPage.js').then((m) => ({ default: m.WorkroomsPage })));
const StartWorkPage = lazy(() => import('./pages/StartWorkPage.js').then((m) => ({ default: m.StartWorkPage })));

const StrategiesPage = lazy(() => import('./pages/StrategiesPage.js').then((m) => ({ default: m.StrategiesPage })));
const WorkspacesPage = lazy(() => import('./pages/WorkspacesPage.js').then((m) => ({ default: m.WorkspacesPage })));
const GettingStartedPage = lazy(() =>
  import('./features/guide/GettingStartedPage.js').then((m) => ({ default: m.GettingStartedPage })),
);
import { API_BASE } from './lib/apiBase.js';
import { apiFetch } from './lib/api/client.js';
import {
  useAiDetect,
  useEditorDetect,
  useRepos,
  useWorkflowTemplates,
  useWorkspaces,
  useWorkspacesStatus,
  type WorkflowTemplate,
} from './lib/api/queries.js';
import { useQueryClient } from '@tanstack/react-query';
// Types canonicalized in ./types.ts — never redeclare them here.
import type {
  AISession,
  DetectedAI,
  DetectedEditor,
  Feature,
  ContextSpaceConfig,
  RepoInfo,
  StorageAdapterMeta,
  TranscriptMessage,
  WorkspaceStatus,
  CommitRepoResult,
} from './types.js';
import {
  BRAND_NAME,
  CLI_NAME,
  GITHUB_RELEASE_URL,
  KNOWLEDGE_FILE,
} from './brand.js';

/** A stable empty list, so a hook that depends on the workspaces does not run again on every render while they load. */
const NO_WORKSPACES: Feature[] = [];
const isVsCode = new URLSearchParams(window.location.search).get('env') === 'vscode';
const nativeUpdateBridge = typeof window !== 'undefined' ? (window.contextspaceBridge?.updates || window.nexusBridge?.updates) : undefined;
let toastIdCounter = 0;

/**
 * Starts a load of one kind of workspace data, aborting the previous load of
 * that kind so a slow response cannot land after a newer one.
 */
function beginWorkspaceLoad(loads: Map<string, AbortController>, kind: string): AbortSignal {
  loads.get(kind)?.abort();
  const controller = new AbortController();
  loads.set(kind, controller);
  return controller.signal;
}

/** The last changes, sessions and plan shown for a workspace. */
interface RecentWorkspaceData { changes?: any[]; sessions?: AISession[] }
const RECENT_WORKSPACE_DATA_LIMIT = 16;

function rememberWorkspaceData(recent: Map<string, RecentWorkspaceData>, wsId: string, data: RecentWorkspaceData): void {
  const merged = { ...recent.get(wsId), ...data };
  recent.delete(wsId);
  recent.set(wsId, merged);
  if (recent.size > RECENT_WORKSPACE_DATA_LIMIT) recent.delete(recent.keys().next().value!);
}

type UiUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string | null;
  releaseUrl?: string | null;
  releaseNotes?: string | null;
  nativeStatus?: ContextSpaceDesktopUpdateState['status'];
  progress?: number;
  error?: string | null;
};

function AppInner() {
  const navigate = useNavigate();
  const location = useLocation();

  // Toast State
  const [toasts, setToasts] = useState<Toast[]>([]);
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info', duration = 5000) => {
    const id = `toast-${++toastIdCounter}`;
    setToasts((prev) => [...prev, { id, message, type, duration }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  };
  
  // App Config
  const [config, setConfig] = useState<ContextSpaceConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configExists, setConfigExists] = useState<boolean>(true);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; fields: ConfigPathsReport | null } | null>(null);
  const [adapters, setAdapters] = useState<StorageAdapterMeta[]>([]);

  // Update Check State
  const [updateStatus, setUpdateStatus] = useState<UiUpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [defaultPaths, setDefaultPaths] = useState<{ devDir: string; workspacesDir: string } | null>(null);
  const [serverPlatform, setServerPlatform] = useState<string | undefined>(undefined);
  const [updateDeferred, setUpdateDeferred] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);

  // Repos & tool detection come from the shared react-query cache (same data
  // the Projects/Start-work pages read) — one fetch, one source of truth.
  const reposQuery = useRepos();
  // Detection starts about 17 programs (each tool's and editor's --version). Only the strategies page (the inspect
  // assistant) and Settings (the editors) use it here, so the overview and workspaces start without it.
  const detectionShown = /^\/(workflows|strategies|settings)/.test(location.pathname);
  const aiDetectQuery = useAiDetect({ enabled: detectionShown });
  const editorsQuery = useEditorDetect({ enabled: detectionShown });
  const templatesQuery = useWorkflowTemplates();
  const repos: RepoInfo[] = reposQuery.data ?? [];
  const aiAssistants: DetectedAI[] = aiDetectQuery.data ?? [];
  const editors: DetectedEditor[] = editorsQuery.data ?? [];
  const workflowTemplates: WorkflowTemplate[] = templatesQuery.data ?? [];

  // App Autoupdate State
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateStep, setUpdateStep] = useState<'idle' | 'checking' | 'downloading' | 'downloaded' | 'error'>('idle');
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);
  const [workspaceToArchive, setWorkspaceToArchive] = useState<string | null>(null);


  // Workflow Strategy Management State
  const [selectedMgtTemplateId, setSelectedMgtTemplateId] = useState<string | null>(null);
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [mgtTemplateName, setMgtTemplateName] = useState('');
  const [mgtTemplateContent, setMgtTemplateContent] = useState('');
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [analyzingTemplate, setAnalyzingTemplate] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [selectedInspectAssistant, setSelectedInspectAssistant] = useState<string>('antigravity');

  // Default the inspect-assistant to the first launchable detected one —
  // exactly ONCE. A background refetch must never clobber a manual selection.
  const inspectAssistantSeededRef = useRef(false);
  useEffect(() => {
    if (inspectAssistantSeededRef.current || !aiDetectQuery.data) return;
    const firstHarness = aiDetectQuery.data.find((ai) => ai.detected && ai.command);
    if (firstHarness) {
      inspectAssistantSeededRef.current = true;
      setSelectedInspectAssistant(firstHarness.name);
    }
  }, [aiDetectQuery.data]);
  const [suggestedImprovement, setSuggestedImprovement] = useState<string | null>(null);
  const [mgtAnalysisComment, setMgtAnalysisComment] = useState('');

  // Workspaces list + at-a-glance statuses live in the shared react-query
  // cache — the same one the StartWorkPage/ProjectsPage mutations invalidate,
  // so a created or deleted workspace shows up here without manual syncing.
  // Status checks are expensive server-side, so fetch bounded pages only on
  // routes that display them. The overview shows progress until totals settle.
  const onStatusRoute = ['/', '/overview', '/dashboard'].includes(location.pathname) || location.pathname.startsWith('/workspaces');
  const queryClient = useQueryClient();
  const workspacesQuery = useWorkspaces();
  useWorkspaceShortcuts();
  useEffect(() => { if (config) perfMarkOnce('cs:shell'); }, [config]);
  const statusesQuery = useWorkspacesStatus({
    enabled: configExists && !configLoading && onStatusRoute,
    intervalMs: onStatusRoute && (workspacesQuery.data?.length ?? 0) <= 24 ? 15_000 : false,
  });
  const { hasNextPage, isFetching: isFetchingStatuses, isError: statusesError, fetchNextPage } = statusesQuery;
  useEffect(() => {
    if (onStatusRoute && hasNextPage && !isFetchingStatuses && !statusesError) {
      void fetchNextPage();
    }
  }, [onStatusRoute, hasNextPage, isFetchingStatuses, statusesError, fetchNextPage]);
  const workspaces: Feature[] = workspacesQuery.data ?? [];
  useDropArchivedTabs(workspacesQuery.data ?? NO_WORKSPACES);
  // Archived workspaces are records: pages that start work only offer active ones.
  const activeWorkspaces = useMemo(() => (workspacesQuery.data ?? []).filter((w) => !w.archivedAt), [workspacesQuery.data]);
  const workspacesLoading = workspacesQuery.isLoading;
  const workspaceStatuses: Record<string, WorkspaceStatus> = Object.assign({},
    ...(statusesQuery.data?.pages.map((page) => page.statuses) ?? []));
  const lastStatusPage = statusesQuery.data?.pages.at(-1);
  const checkedWorkspaceCount = lastStatusPage?.nextOffset ?? lastStatusPage?.total ?? 0;
  const statusesComplete = !statusesQuery.isLoading && !statusesQuery.hasNextPage && !statusesQuery.isError;

  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<WorkspaceSection>('chat');
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSession, setActiveSession] = useState<AISession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [gitChanges, setGitChanges] = useState<any[]>([]);
  const [knowledgeContent, setKnowledgeContent] = useState<string>('');
  const [knowledgeLoading, setKnowledgeLoading] = useState<boolean>(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [isEditingKnowledge, setIsEditingKnowledge] = useState<boolean>(false);
  const [editedKnowledge, setEditedKnowledge] = useState<string>('');
  const [saveKnowledgeLoading, setSaveKnowledgeLoading] = useState<boolean>(false);
  const [saveKnowledgeError, setSaveKnowledgeError] = useState<string | null>(null);
  const activeWorkspaceRef = useRef<string | null>(null);
  const knowledgeLoadRequestRef = useRef(0);
  const saveKnowledgeRequestRef = useRef(0);
  // One in-flight load per kind of workspace data; see beginWorkspaceLoad.
  const workspaceLoadsRef = useRef(new Map<string, AbortController>());
  // Switching back to a recent workspace shows its last data at once while a
  // fresh load runs, instead of an empty view until every request returns.
  const recentWorkspaceDataRef = useRef(new Map<string, RecentWorkspaceData>());
  const editedKnowledgeRef = useRef('');
  const isEditingKnowledgeRef = useRef(false);
  const [syncLoading, setSyncLoading] = useState<boolean>(false);
  const [syncResults, setSyncResults] = useState<any[] | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [showCommitModal, setShowCommitModal] = useState<boolean>(false);
  const [commitResults, setCommitResults] = useState<CommitRepoResult[] | null>(null);
  const [deleteWsLoading, setDeleteWsLoading] = useState<string | null>(null);
  const [addRepoLoading, setAddRepoLoading] = useState<boolean>(false);

  // Keep refs in sync with the editor controls so async document requests can
  // preserve a draft even when the user types while a request is in flight.
  const updateEditedKnowledge = (value: string) => {
    editedKnowledgeRef.current = value;
    setEditedKnowledge(value);
  };
  const updateIsEditingKnowledge = (value: boolean) => {
    isEditingKnowledgeRef.current = value;
    setIsEditingKnowledge(value);
  };

  // AI toolchain update states
  const [toolsStatus, setToolsStatus] = useState<any[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [updatingToolId, setUpdatingToolId] = useState<string | null>(null);


  const isSettingsFormValid = (() => {
    if (!config) return false;
    if (!config.devDir || config.devDir.trim() === '' || !config.workspacesDir || config.workspacesDir.trim() === '') return false;
    return true;
  })();

  // Effects moved below helper functions to resolve lexical declaration order

  // ─── API Fetches ────────────────────────────────────────────────────────

  const applyNativeUpdateState = (state: ContextSpaceDesktopUpdateState) => {
    const isAvailable = ['available', 'downloading', 'downloaded', 'error'].includes(state.status)
      && Boolean(state.version);
    setUpdateStatus({
      currentVersion: state.currentVersion,
      latestVersion: state.version || state.currentVersion,
      updateAvailable: isAvailable,
      releaseNotes: state.releaseNotes,
      nativeStatus: state.status,
      progress: state.progress,
      error: state.error,
      releaseUrl: GITHUB_RELEASE_URL,
    });
    setAppVersion(state.currentVersion);
    if (state.status === 'error') {
      setUpdateCheckError(state.error || `${BRAND_NAME} could not check or download the update.`);
    } else if (state.status !== 'checking') {
      setUpdateCheckError(null);
    }
    setUpdatingApp(state.status === 'checking' || state.status === 'downloading');
    setUpdateStep(
      state.status === 'checking' ? 'checking'
        : state.status === 'downloading' ? 'downloading'
          : state.status === 'downloaded' ? 'downloaded'
            : state.status === 'error' ? 'error' : 'idle',
    );
    if (state.status === 'available') setUpdateDeferred(false);
  };

  const fetchUpdateStatus = async (checkNative = true) => {
    try {
      if (nativeUpdateBridge) {
        const initial = await nativeUpdateBridge.getStatus();
        applyNativeUpdateState(initial);
        if (checkNative && initial.status !== 'unsupported') {
          applyNativeUpdateState(await nativeUpdateBridge.check());
        }
        return;
      }
      const res = await fetch(`${API_BASE}/api/update-status`);
      if (res.ok) {
        const data = await res.json();
        setUpdateStatus(data);
        setUpdateCheckError(null);
        if (data.currentVersion) {
          setAppVersion(data.currentVersion);
        }
      } else {
        throw new Error(`Update check failed with HTTP ${res.status}.`);
      }
    } catch (e) {
      setUpdateCheckError(e instanceof Error ? e.message : `${BRAND_NAME} could not check for updates.`);
      console.error('Failed to fetch update status:', e);
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateCheckError(null);
    // A downloaded update is intentionally protected from another metadata
    // check in the main process. Let the manual check button reopen the
    // optional banner without losing the pending Restart & Install action.
    if (updateStatus?.nativeStatus === 'downloaded') setUpdateDeferred(false);
    await fetchUpdateStatus(true);
  };

  const handleAutoUpdate = async () => {
    if (!nativeUpdateBridge) {
      showToast(`Native installation is available in the ${BRAND_NAME} desktop app. Open the release page to install it.`, 'info');
      return;
    }

    setUpdatingApp(true);
    setUpdateStep('downloading');

    try {
      const nextState = await nativeUpdateBridge.download();
      applyNativeUpdateState(nextState);
      if (nextState.status === 'downloaded') {
        showToast(`Update downloaded. Restart ${BRAND_NAME} when you are ready to install it.`, 'success');
      } else {
        showToast(`Update failed: ${nextState.error || 'The download did not complete.'}`, 'error');
      }
    } catch (err) {
      console.error('Update failed:', err);
      setUpdateStep('error');
      setUpdatingApp(false);
      showToast(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleRestartUpdate = async () => {
    if (!nativeUpdateBridge) return;
    try {
      applyNativeUpdateState(await nativeUpdateBridge.restart());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setUpdateStatus((previous) => previous ? {
        ...previous,
        nativeStatus: 'error',
        error: message,
        updateAvailable: Boolean(previous.latestVersion),
      } : previous);
      setUpdateCheckError(message);
      setUpdateStep('error');
      showToast(`Could not restart for update: ${message}`, 'error');
      setUpdatingApp(false);
    }
  };


  const fetchAdapters = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/adapters`);
      const data = await res.json();
      if (data.adapters) {
        setAdapters(data.adapters);
      }
    } catch (e) {
      console.error('Failed to fetch adapters:', e);
    }
  };

  const fetchConfig = async () => {
    fetchAdapters();
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      const data = await res.json();
      setConfig(data.config);
      setConfigExists(data.exists);
      setServerPlatform(typeof data.platform === 'string' ? data.platform : undefined);

      if (!(data.exists && data.config.devDir)) {
        setDefaultPaths({
          devDir: data.suggested?.devDir || data.config.devDir || '',
          workspacesDir: data.suggested?.workspacesDir || data.config.workspacesDir || '',
        });
        setConfig({
          version: '1.0.0',
          devDir: '',
          workspacesDir: '',
          defaultAssistant: null,
          scanDepth: 2,
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setConfigLoading(false);
    }
  };

  const saveAppConfig = async (newConfig: ContextSpaceConfig) => {
    setSaveError(null);
    try {
      const result = await postConfig(newConfig);
      setSaveStatus('success');
      setConfig({ ...newConfig, ...result.config });
      setConfigExists(true);
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      fetchWorkspaces();
      setTimeout(() => setSaveStatus((status) => status === 'success' ? null : status), 3000);
    } catch (error) {
      // Keep the error until the next save: the user needs it to fix the entry.
      setSaveStatus('error');
      setSaveError({ message: error instanceof Error ? error.message : 'Could not save settings.', fields: folderErrors(error) });
    }
  };

  // Kept as the single "refresh workspaces" entry point for the handlers and
  // pages that call it — it now refreshes the shared react-query cache.
  const fetchWorkspaces = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces-status'] }),
    ]);
  };

  const handleSaveTemplate = async () => {
    if (!mgtTemplateName.trim() || !mgtTemplateContent.trim()) {
      showToast('Name and content are required.', 'error');
      return;
    }
    setSavingTemplate(true);
    try {
      const res = await fetch(`${API_BASE}/api/workflows/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedMgtTemplateId,
          name: mgtTemplateName,
          content: mgtTemplateContent,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        showToast('Strategy template saved successfully!', 'success');
        await queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
        setSelectedMgtTemplateId(data.template.id);
        setIsEditingTemplate(false);
        setAnalysisResult(null);
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to save template', 'error');
      }
    } catch (e) {
      showToast(toErrorMessage(e, 'Error saving template'), 'error');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this custom strategy template?')) {
      return;
    }
    setDeletingTemplate(true);
    try {
      const res = await fetch(`${API_BASE}/api/workflows/templates/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showToast('Strategy template deleted successfully!', 'success');
        await queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
        setSelectedMgtTemplateId(null);
        setAnalysisResult(null);
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to delete template', 'error');
      }
    } catch (e) {
      showToast(toErrorMessage(e, 'Error deleting template'), 'error');
    } finally {
      setDeletingTemplate(false);
    }
  };

  const handleAnalyzeTemplate = async (id: string, content: string, assistant: string) => {
    setAnalyzingTemplate(true);
    setAnalysisResult(null);
    setSuggestedImprovement(null);
    try {
      const res = await fetch(`${API_BASE}/api/workflows/templates/${encodeURIComponent(id)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, assistant, comment: mgtAnalysisComment }),
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysisResult(data.analysis);
        setSuggestedImprovement(data.suggestedImprovement || null);
        showToast('Strategy analysis completed successfully!', 'success');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to analyze template using the selected assistant harness.', 'error');
      }
    } catch (e) {
      showToast(toErrorMessage(e, 'Error analyzing template'), 'error');
    } finally {
      setAnalyzingTemplate(false);
    }
  };

  const fetchGitChanges = async (wsId: string) => {
    const signal = beginWorkspaceLoad(workspaceLoadsRef.current, 'changes');
    const isCurrent = () => !signal.aborted && activeWorkspaceRef.current === wsId;
    try {
      const encodedId = encodeURIComponent(wsId);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/changes`, { signal });
      const data = await res.json();
      perfMark('cs:ws-data', { id: wsId, kind: 'changes', applied: isCurrent() });
      if (!isCurrent()) return;
      // A failed reply keeps the list on screen; it must not read as "no changes".
      const changes = changesFromResponse<any>(res, data);
      setGitChanges(changes);
      rememberWorkspaceData(recentWorkspaceDataRef.current, wsId, { changes });
    } catch (e) {
      if (isCurrent()) console.error(e);
    }
  };

  const fetchWorkspaceSessions = async (wsId: string) => {
    const signal = beginWorkspaceLoad(workspaceLoadsRef.current, 'sessions');
    const isCurrent = () => !signal.aborted && activeWorkspaceRef.current === wsId;
    setSessionsLoading(true);
    try {
      const encodedId = encodeURIComponent(wsId);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/sessions`, { signal });
      const data = await res.json();
      perfMark('cs:ws-data', { id: wsId, kind: 'sessions', applied: isCurrent() });
      if (!isCurrent()) return;
      setSessions(data.sessions || []);
      rememberWorkspaceData(recentWorkspaceDataRef.current, wsId, { sessions: data.sessions || [] });
    } catch (e) {
      if (isCurrent()) console.error(e);
    } finally {
      if (isCurrent()) setSessionsLoading(false);
    }
  };

  const fetchSessionTranscript = async (assistant: string, sessionId: string) => {
    setTranscriptLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/session/${assistant}/${sessionId}/transcript`);
      const data = await res.json();
      setTranscript(data.messages || []);
    } catch (e) {
      console.error(e);
    } finally {
      setTranscriptLoading(false);
    }
  };


  const fetchKnowledge = async (wsId: string) => {
    const requestId = ++knowledgeLoadRequestRef.current;
    const isCurrentRequest = () =>
      activeWorkspaceRef.current === wsId && knowledgeLoadRequestRef.current === requestId;

    const signal = beginWorkspaceLoad(workspaceLoadsRef.current, 'knowledge');
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    try {
      const encodedId = encodeURIComponent(wsId);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/knowledge`, { signal });
      if (!res.ok) throw new Error('knowledge request failed');
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object' || typeof (data as { content?: unknown }).content !== 'string') {
        throw new Error('knowledge response was malformed');
      }
      if (!isCurrentRequest()) return;

      const content = (data as { content: string }).content;
      setKnowledgeContent(content);
      // A retry can finish after the editor opened and the user started
      // typing. In that case the loaded revision must not replace the draft.
      if (!isEditingKnowledgeRef.current) {
        editedKnowledgeRef.current = content;
        setEditedKnowledge(content);
      }
      setKnowledgeError(null);
    } catch (e) {
      if (!isCurrentRequest()) return;
      console.error('Failed to load workspace knowledge:', e);
      setKnowledgeError('Could not load Knowledge. Existing content and your draft were kept. Retry when ready.');
    } finally {
      if (isCurrentRequest()) setKnowledgeLoading(false);
    }
  };

  const handleSaveKnowledge = async (wsId: string) => {
    const requestId = ++saveKnowledgeRequestRef.current;
    const draftToSave = editedKnowledgeRef.current;
    const isCurrentRequest = () =>
      activeWorkspaceRef.current === wsId && saveKnowledgeRequestRef.current === requestId;

    setSaveKnowledgeLoading(true);
    setSaveKnowledgeError(null);
    try {
      const encodedId = encodeURIComponent(wsId);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/knowledge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draftToSave }),
      });
      if (!res.ok) throw new Error('knowledge save request failed');
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object' || (data as { success?: unknown }).success !== true) {
        throw new Error('knowledge save response was not confirmed');
      }
      if (!isCurrentRequest()) return;

      // A load that started before this confirmed save is now stale. Advance
      // the load generation before publishing the saved revision so a late
      // response cannot overwrite it or put the spinner back into the view.
      knowledgeLoadRequestRef.current += 1;
      setKnowledgeLoading(false);
      setKnowledgeContent(draftToSave);
      setKnowledgeError(null);
      setSaveKnowledgeError(null);
      // If typing continued while the save was pending, keep the editor open
      // with the newer draft while recording the confirmed saved revision.
      if (isEditingKnowledgeRef.current && editedKnowledgeRef.current === draftToSave) {
        updateIsEditingKnowledge(false);
      }
    } catch (e) {
      if (!isCurrentRequest()) return;
      console.error('Failed to save workspace knowledge:', e);
      setSaveKnowledgeError('Could not save Knowledge. Your draft is still open. Retry the save.');
    } finally {
      if (isCurrentRequest()) setSaveKnowledgeLoading(false);
    }
  };

  const handleSyncAll = async (wsId: string) => {
    setSyncLoading(true);
    setSyncResults(null);
    try {
      const encodedId = encodeURIComponent(wsId);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/sync`, { method: 'POST' });
      const data = await res.json();
      setSyncResults(data.results || []);
      fetchGitChanges(wsId);
    } catch (e) {
      console.error(e);
    } finally {
      setSyncLoading(false);
    }
  };

  // ─── Actions ────────────────────────────────────────────────────────────

  const handleOpenDesktopSession = async (
    ws: Feature,
    sessionId: string,
    assistant: string,
  ): Promise<boolean> => {
    if (assistant !== 'codex') {
      const cmd = assistant === 'claude'
        ? `claude --resume ${sessionId}`
        : assistant === 'copilot'
          ? `copilot --resume ${sessionId}`
          : assistant === 'cursor'
            ? `cursor-agent --resume ${sessionId}`
            : assistant === 'pi'
              ? `pi --session ${sessionId}`
              : `agy --conversation ${sessionId}`;
      await safeCopyToClipboard(cmd);
      showToast(`Copied ${assistant} resume command to clipboard:\n\n${cmd}`, 'info');
      return true;
    }

    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(ws.branchName)}/launch`, {
        method: 'POST',
        body: JSON.stringify({
          targetId: 'codex-desktop',
          action: 'resume',
          sessionId,
        }),
      });
      showToast('Sent the existing session to Codex Desktop.', 'success');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return false;
    }
  };

  const executeTerminal = async (command: string) => {
    if (!activeWsId) return;
    const ws = workspaces.find(w => w.branchName === activeWsId);
    if (!ws) return;
    if (isVsCode) {
      window.parent.postMessage({
        type: 'executeTerminalCommand',
        command,
        cwd: ws.workspacePath
      }, '*');
      return;
    }
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(ws.branchName)}/terminal`, {
        method: 'POST',
        body: JSON.stringify({ command }),
      });
    } catch (e) {
      showToast(`Terminal error: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };



  // Initial loads (list/detection data loads itself via the query hooks)
  useEffect(() => {
    fetchConfig();
    fetchUpdateStatus();

    // Support auto-loading workspace from VS Code or URL params
    const queryParams = new URLSearchParams(window.location.search);
    const queryWsId = queryParams.get('workspaceId');
    if (queryWsId) {
      navigate(`/workspaces/${encodeURIComponent(queryWsId)}`);
    }
  }, []);

  // Native update events originate in Electron's main process. Browser mode
  // has no bridge, but the rest of the dashboard remains fully functional;
  // only native update installation is unavailable there.
  useEffect(() => {
    if (!nativeUpdateBridge) return;
    return nativeUpdateBridge.onEvent(applyNativeUpdateState);
  }, []);

  // Keep workspace selection (and its data-loading effects) in sync with the
  // route. Clearing the selection off-route matters: the services/log polling
  // intervals below are keyed on activeWsId and would otherwise keep firing
  // forever while the user sits on Settings or the Dashboard.
  useEffect(() => {
    const p = location.pathname;
    if (p.startsWith('/workspaces')) {
      const parts = p.split('/').filter(Boolean); // ['workspaces', id?, tab?]
      // Choosing which chat a route opens is the chat slot's job: it tells a user's own navigation from a stale one
      // and does not reopen a chat that was closed. Revealing it here as well would undo both.
      setActiveWsId(parts[1] ? decodeURIComponent(parts[1]) : null);
      // One list of sections, shared with the workspace navigation: no section opens the chat.
      setSubTab(parseSection(parts[2]));
    } else {
      setActiveWsId(null);
    }
  }, [location.pathname]);

  const fetchToolsStatus = async (force = false) => {
    setToolsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/updates/tools${force ? '?force=true' : ''}`);
      if (res.ok) {
        setToolsStatus(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch tools status:', e);
    } finally {
      setToolsLoading(false);
    }
  };

  const handleUpdateTool = async (toolId: string) => {
    setUpdatingToolId(toolId);
    try {
      const res = await fetch(`${API_BASE}/api/updates/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`${toolId} updated successfully!\n\nOutput:\n${data.output}`, 'success');
        fetchToolsStatus(true);
        fetchUpdateStatus();
      } else {
        showToast(`Error: ${data.error || 'Failed to update tool'}`, 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error when updating tool.', 'error');
    } finally {
      setUpdatingToolId(null);
    }
  };

  // Tool registry requests are explicit (Settings → Check Now), so opening
  // the data guide does not initiate a toolchain update check.

  // Reset workspace-scoped state whenever the active workspace changes to prevent stale data leaks
  useEffect(() => {
    activeWorkspaceRef.current = activeWsId;
    // Invalidate every in-flight operation before clearing the old workspace's
    // view. Late responses then fail their identity check and cannot repopulate
    // this state with another workspace's document or draft.
    knowledgeLoadRequestRef.current += 1;
    saveKnowledgeRequestRef.current += 1;
    for (const controller of workspaceLoadsRef.current.values()) controller.abort();
    workspaceLoadsRef.current.clear();
    const recent = activeWsId ? recentWorkspaceDataRef.current.get(activeWsId) : undefined;
    setSessions(recent?.sessions ?? []);
    setSessionsLoading(false);
    setGitChanges(recent?.changes ?? []);
    setKnowledgeContent('');
    setKnowledgeError(null);
    setKnowledgeLoading(false);
    setSaveKnowledgeError(null);
    setSaveKnowledgeLoading(false);
    editedKnowledgeRef.current = '';
    isEditingKnowledgeRef.current = false;
    setEditedKnowledge('');
    setIsEditingKnowledge(false);
    if (activeWsId && recent) {
      for (const kind of ['changes', 'sessions'] as const) {
        if (recent[kind] !== undefined) perfMark('cs:ws-data', { id: activeWsId, kind, applied: true, cached: true });
      }
    }
  }, [activeWsId]);

  // Load git changes for the Changes tab and the Overview (per-repo topology panel)
  useEffect(() => {
    if (activeWsId && (subTab === 'changes' || subTab === 'overview')) {
      fetchGitChanges(activeWsId);
    }
  }, [activeWsId, subTab]);

  // Load sessions when active workspace changes or subTab switches to 'sessions' or 'overview'
  useEffect(() => {
    if (activeWsId && (subTab === 'sessions' || subTab === 'overview')) {
      fetchWorkspaceSessions(activeWsId);
    }
  }, [activeWsId, subTab]);

  // Load knowledge when subTab switches to 'knowledge' or active workspace changes
  useEffect(() => {
    if (activeWsId && subTab === 'knowledge') {
      fetchKnowledge(activeWsId);
    }
  }, [activeWsId, subTab]);

  const handleCopyPrompt = async (ws: Feature) => {
    const repoNames = ws.repos.map((r) => r.split(/[\\/]/).pop()).join(', ');
    const prompt = `You are an AI assistant helping with feature development.
We are working in a multi-repository workspace.

Workspace Metadata:
- Feature Branch: ${ws.branchName}
- Purpose & Context: ${ws.description?.trim() || ws.name || ws.branchName}
- Mapped Repositories: ${repoNames}

Core Instructions:
1. Read "AGENTS.md" at the workspace root first — it names the repos, how they depend on each other, which to change first, and how to verify each.
2. Search "${KNOWLEDGE_FILE}" for decisions and gotchas from earlier sessions rather than reading it whole, and record new ones with \`${CLI_NAME} knowledge add\`. "PLAN.md" is the plan: keep it true as you work.
3. Follow all project-specific rules in "CLAUDE.md", ".cursorrules", or "AGENTS.md" inside sub-repositories.
`;
    const copied = await safeCopyToClipboard(prompt);
    if (copied) {
      showToast('AI context prompt copied to clipboard!', 'success');
    } else {
      showToast('Could not copy prompt to clipboard. Please check browser permissions.', 'error');
    }
  };

  const handleDeleteWorkspace = async (wsName: string) => {
    setWorkspaceToDelete(wsName);
  };

  const handleArchiveWorkspace = (wsName: string) => {
    setWorkspaceToArchive(wsName);
  };

  const handleArchived = async (wsName: string) => {
    // A record has no session: its terminals stop and its tab closes, without moving the person to another chat.
    const ended = await endWorkspaceSession(wsName);
    void queryClient.invalidateQueries({ queryKey: RUNNING_TERMINALS_KEY });
    await fetchWorkspaces();
    if (ended.failed > 0) {
      showToast(`Archived ${wsName}, but ${ended.failed === 1 ? 'a running session' : `${ended.failed} running sessions`} could not be stopped and may still be running.`, 'error');
      return;
    }
    showToast(`Archived ${wsName}.${ended.stopped > 0 ? ' Its running session was stopped.' : ''} Its record stays readable under Archived workspaces.`, 'success');
  };

  const handleUnarchiveWorkspace = async (wsName: string) => {
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(wsName)}/unarchive`, { method: 'POST' });
      await fetchWorkspaces();
      showToast(`Restored ${wsName}. Prepare a repository for editing to work in it again.`, 'success');
    } catch (error) {
      showToast(`Could not restore ${wsName}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  const confirmDeleteWorkspace = async (wsName: string) => {
    setDeleteWsLoading(wsName);
    try {
      const encodedId = encodeURIComponent(wsName);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok && data.success) {
        // Its session tab goes with it, or the sidebar keeps a row that leads to a workspace that is not there.
        floatingChatStore.removeTab(wsName);
        // The list is read again before leaving, or the address that leads to "a workspace" still finds this one.
        await fetchWorkspaces();
        if (activeWsId === wsName) {
          // Leave the deleted workspace's URL too — otherwise a reload would
          // re-select the dead id and poll its services endpoint forever.
          navigate('/workspaces');
        }
        showToast(`Workspace ${wsName} successfully deleted.`, 'success');
        setWorkspaceToDelete(null);
      } else {
        showToast(`Failed to delete workspace: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error while deleting workspace.', 'error');
    } finally {
      setDeleteWsLoading(null);
    }
  };

  const handleAddRepo = async (wsName: string, repoPath: string) => {
    setAddRepoLoading(true);
    try {
      const encodedId = encodeURIComponent(wsName);
      const res = await fetch(`${API_BASE}/api/workspace/${encodedId}/repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchWorkspaces();
        // The Services tab (react-query) refreshes itself; nudge the caches the
        // added repo affects.
        queryClient.invalidateQueries({ queryKey: ['workspace-services', wsName] });
        if (activeWsId === wsName) {
          fetchGitChanges(wsName);
          fetchWorkspaceSessions(wsName);
        }
        showToast('Repository successfully added and configurations updated.', 'success');
      } else {
        showToast(`Failed to add repository: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error while adding repository.', 'error');
    } finally {
      setAddRepoLoading(false);
    }
  };

  if (!configExists && config) {
    return (
      <SetupPage
        initialConfig={config}
        suggested={defaultPaths}
        platform={serverPlatform}
        adapters={adapters}
        onComplete={(saved) => {
          setConfig(saved);
          setConfigExists(true);
          void fetchWorkspaces();
        }}
      />
    );
  }

  if (isVsCode) {
    return (
      <VsCodeShell
        activeWsId={activeWsId}
        setActiveWsId={setActiveWsId}
        appVersion={appVersion}
        workspaces={activeWorkspaces}
        executeTerminal={executeTerminal}
      />
    );
  }

  const dashboardPage = config ? (
    <DashboardPage
      workspaces={activeWorkspaces}
      workspaceStatuses={workspaceStatuses}
      workspacesLoading={workspacesLoading}
      checkedWorkspaceCount={checkedWorkspaceCount}
      statusesComplete={statusesComplete}
      statusesError={statusesQuery.isError}
      onRetryStatuses={() => { void statusesQuery.refetch(); }}
      onOpenWorkspace={(id) => navigate(`/workspaces/${encodeURIComponent(id)}`)}
      onNewWorkspace={() => navigate('/new')}
      showToast={showToast}
    />
  ) : null;

  const guidePage = config ? (
    <GettingStartedPage
      config={config}
      onCreateWorkspace={() => navigate('/new')}
      onModifySettings={() => navigate('/settings')}
    />
  ) : null;

  const startWorkPage = config ? <StartWorkPage /> : null;
  const projectsPage = config ? <ProjectsPage /> : null;

  const workspacesPage = (
    <WorkspacesPage
      workspaces={workspaces}
      workspaceStatuses={workspaceStatuses}
      workspacesLoading={workspacesLoading}
      fetchWorkspaces={fetchWorkspaces}
      selectedId={activeWsId}
      subTab={subTab}
      onSelect={(id) => navigate(`/workspaces/${encodeURIComponent(id)}`)}
      onSelectTab={(id, tab) => navigate(`/workspaces/${encodeURIComponent(id)}/${tab}`)}
      handleCopyPrompt={handleCopyPrompt}
      handleDeleteWorkspace={handleDeleteWorkspace}
      handleArchiveWorkspace={handleArchiveWorkspace}
      handleUnarchiveWorkspace={handleUnarchiveWorkspace}
      deleteWsLoading={deleteWsLoading}
      repos={repos}
      addRepoLoading={addRepoLoading}
      handleAddRepo={handleAddRepo}
      sessionProps={{ sessions, sessionsLoading, setActiveSession, setTranscript, fetchSessionTranscript, handleOpenDesktopSession, showToast }}
      changesProps={{ gitChanges, syncLoading, syncResults, commitMessage, showCommitModal, commitResults, setSyncResults, setCommitResults, setCommitMessage, setShowCommitModal, fetchGitChanges, handleSyncAll }}
      knowledgeProps={{
        knowledgeContent,
        knowledgeLoading,
        knowledgeError,
        isEditingKnowledge,
        editedKnowledge,
        saveKnowledgeLoading,
        saveKnowledgeError,
        setEditedKnowledge: updateEditedKnowledge,
        setIsEditingKnowledge: updateIsEditingKnowledge,
        handleSaveKnowledge,
        handleRetryKnowledge: fetchKnowledge,
      }}
      showToast={showToast}
    />
  );

  const workflowsPage = (
    <StrategiesPage
      workflowTemplates={workflowTemplates} isEditingTemplate={isEditingTemplate} setIsEditingTemplate={setIsEditingTemplate}
      mgtTemplateName={mgtTemplateName} setMgtTemplateName={setMgtTemplateName} mgtTemplateContent={mgtTemplateContent} setMgtTemplateContent={setMgtTemplateContent}
      selectedMgtTemplateId={selectedMgtTemplateId} setSelectedMgtTemplateId={setSelectedMgtTemplateId}
      analysisResult={analysisResult} setAnalysisResult={setAnalysisResult} showToast={showToast}
      handleAnalyzeTemplate={handleAnalyzeTemplate} handleSaveTemplate={handleSaveTemplate} handleDeleteTemplate={handleDeleteTemplate}
      aiAssistants={aiAssistants} analyzingTemplate={analyzingTemplate} mgtAnalysisComment={mgtAnalysisComment} setMgtAnalysisComment={setMgtAnalysisComment}
      suggestedImprovement={suggestedImprovement} setSuggestedImprovement={setSuggestedImprovement} savingTemplate={savingTemplate} deletingTemplate={deletingTemplate}
      selectedInspectAssistant={selectedInspectAssistant} setSelectedInspectAssistant={setSelectedInspectAssistant}
    />
  );

  const skillsPage = <SkillsPage showToast={showToast} />;
  const agentsPage = <AgentsPage showToast={showToast} />;
  const workroomsPage = <WorkroomsPage workspaces={activeWorkspaces} showToast={showToast} />;

  const settingsPage = config ? (
    <SettingsPage
      workspaces={workspaces}
      config={config} setConfig={setConfig} saveStatus={saveStatus} saveError={saveError} editors={editors} adapters={adapters}
      saveAppConfig={saveAppConfig} isSettingsFormValid={isSettingsFormValid}
      toolsStatus={toolsStatus} toolsLoading={toolsLoading} updatingToolId={updatingToolId}
      fetchToolsStatus={fetchToolsStatus} handleUpdateTool={handleUpdateTool}
    />
  ) : null;

  const { openTabs: sessionTabs, activeTab: lastChat } = floatingChatStore.getState();
  const defaultWorkspaceBranch = defaultWorkspaceTarget(activeWorkspaces.map((workspace) => workspace.branchName), activeWsId, lastChat, sessionTabs);
  const isWorkspaceRoute = location.pathname.startsWith('/workspaces');

  return (
    <div className="flex min-h-screen bg-transparent text-foreground max-md:pt-12">
      <AppSidebar
        appVersion={appVersion}
        workspaces={workspaces}
        workspaceStatuses={workspaceStatuses}
        workspacesLoading={workspacesLoading}
        activeWsId={activeWsId}
        onCheckForUpdates={() => { void handleCheckForUpdates(); }}
        checkingForUpdates={['checking', 'downloading'].includes(updateStatus?.nativeStatus ?? '')}
      />

      {/* Main Content Area */}
      <main className={cn('flex-1 min-w-0 h-[calc(100dvh-3rem)] md:h-screen', isWorkspaceRoute ? 'overflow-hidden flex flex-col' : 'overflow-y-auto p-3 sm:p-5 lg:p-6')}>
        {configLoading ? (
          <div className="flex flex-col items-center justify-center py-40 gap-4 text-muted-foreground">
            <RefreshCw className="animate-spin text-primary" size={32} />
            <span className="text-sm font-medium">Loading config settings...</span>
          </div>
        ) : (
          <>
            {/* Checking for updates lives beside the version in the sidebar. This bar appears only when a check failed. */}
            {updateCheckError && (
              <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-border bg-card/50 px-3 py-2.5 text-xs">
                <p className="min-w-0 truncate text-destructive-foreground" role="alert">Could not check for updates: {updateCheckError}</p>
                <button
                  onClick={handleCheckForUpdates}
                  disabled={['checking', 'downloading'].includes(updateStatus?.nativeStatus ?? '')}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  Check again
                </button>
              </div>
            )}
            {/* Update Notification Banner. Updates are always optional: Later
                hides the banner for this session and no native installer is
                exposed when this dashboard is running in a browser. */}
            {updateStatus && updateStatus.updateAvailable && !updateDeferred && (
              <div className="mb-6 p-4 bg-gradient-to-r from-amber-500/10 to-orange-600/10 border border-amber-500/30 rounded-xl shadow-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 backdrop-blur-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-warning-foreground shrink-0">
                    {updatingApp ? (
                      <RefreshCw size={20} className="animate-spin text-warning-foreground" />
                    ) : (
                      <Sparkles size={20} />
                    )}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-warning-foreground">
                      {updateStep === 'error' ? `${BRAND_NAME} update needs attention` : updateStep === 'downloaded' ? 'Update ready to install' : updateStep === 'downloading' ? 'Downloading update…' : `A new version of ${BRAND_NAME} is available!`}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {updateStep === 'error'
                        ? (updateStatus.error || 'The update could not be completed. You can retry or use the release page.')
                        : updateStep === 'downloaded'
                          ? `Restart ${BRAND_NAME} when convenient to install it.`
                          : updateStep === 'downloading'
                            ? `Downloading from GitHub Releases… ${Math.round(updateStatus.progress || 0)}%`
                            : `Upgrade from v${updateStatus.currentVersion} to v${updateStatus.latestVersion} to get the latest features and bug fixes.`}
                    </p>
                    {updateStep === 'downloading' && (
                      <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-amber-950/50" aria-label="Update download progress">
                        <div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.max(0, Math.min(100, updateStatus.progress || 0))}%` }} />
                      </div>
                    )}
                    {updateStatus.releaseNotes && (
                      <details className="mt-2 max-w-xl text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-semibold text-amber-200">Release notes</summary>
                        <p className="mt-1 whitespace-pre-wrap">{updateStatus.releaseNotes}</p>
                      </details>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {nativeUpdateBridge && updateStep === 'downloaded' && (
                    <button
                      onClick={handleRestartUpdate}
                      className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-xs rounded-lg transition-all shadow-md cursor-pointer"
                    >
                      Restart &amp; Install
                    </button>
                  )}
                  {nativeUpdateBridge && updateStep !== 'downloaded' && (
                    <button
                      onClick={handleAutoUpdate}
                      disabled={updatingApp}
                      className="px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold text-xs rounded-lg transition-all shadow-md disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                    >
                      {updateStep === 'error' ? 'Retry download' : updatingApp ? 'Downloading…' : 'Download update'}
                    </button>
                  )}
                  <a
                    href={updateStatus.releaseUrl || GITHUB_RELEASE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 border border-amber-500/30 text-amber-200 hover:bg-amber-500/10 font-semibold text-xs rounded-lg transition-colors"
                  >
                    View release
                  </a>
                  <button
                    onClick={() => setUpdateDeferred(true)}
                    disabled={updatingApp}
                    className="px-3 py-2 border border-border text-muted-foreground hover:text-foreground font-semibold text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    Later
                  </button>
                </div>
              </div>
            )}

            {/* Offline / Backend Unreachable State */}
            {!config && (
              <div className="flex flex-col items-center justify-center py-40 gap-6">
                <div className="bg-red-500/10 p-6 rounded-full">
                  <AlertTriangle className="text-destructive-foreground" size={48} />
                </div>
                <div className="text-center max-w-md">
                  <h2 className="text-2xl font-bold text-white mb-2">Backend Unreachable</h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    The {BRAND_NAME} GUI could not connect to the local server. Make sure you started the GUI correctly via <code>{CLI_NAME} ui</code> or that the backend is running.
                  </p>
                  <button
                    onClick={() => {
                      setConfigLoading(true);
                      fetchConfig();
                      // The list/detection queries exhausted their retries
                      // while the backend was down — refetch them all now.
                      queryClient.invalidateQueries();
                    }}
                    className="px-4 py-2 bg-primary hover:bg-primary/90 text-white font-medium text-sm rounded-md transition-colors cursor-pointer inline-flex items-center gap-2"
                  >
                    <RefreshCw size={16} /> Try Again
                  </button>
                </div>
              </div>
            )}

            <Suspense
              fallback={
                <div className="flex justify-center py-20">
                  <Spinner className="size-6" />
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<ChatHome workspaces={activeWorkspaces} loading={workspacesLoading} ready={Boolean(config)} fallback={dashboardPage} />} />
                <Route path="/overview" element={dashboardPage} />
                <Route path="/dashboard" element={dashboardPage} />
                <Route path="/guide" element={guidePage} />
                <Route path="/create" element={startWorkPage} />
                <Route path="/new" element={startWorkPage} />
                <Route path="/projects" element={projectsPage} />
                <Route
                  path="/workspaces"
                  element={
                    defaultWorkspaceBranch ? (
                      <Navigate to={`/workspaces/${encodeURIComponent(defaultWorkspaceBranch)}`} replace />
                    ) : (
                      <Navigate to="/new" replace />
                    )
                  }
                />
                <Route path="/workspaces/:workspaceId" element={workspacesPage} />
                <Route path="/workspaces/:workspaceId/:tab" element={workspacesPage} />
                <Route path="/skills" element={skillsPage} />
                <Route path="/agents" element={agentsPage} />
                <Route path="/workrooms" element={workroomsPage} />
                <Route path="/settings" element={settingsPage} />
                <Route path="/workflows" element={workflowsPage} />
                <Route path="/strategies" element={workflowsPage} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Routes>
            </Suspense>
          </>
        )}
      </main>

      {activeSession && (
        <TranscriptDialog
          activeSession={activeSession}
          transcript={transcript}
          transcriptLoading={transcriptLoading}
          setActiveSession={setActiveSession}
          workspaces={workspaces}
          workspace={workspaces.find((w) => w.branchName === activeWsId)}
          handleOpenDesktopSession={handleOpenDesktopSession}
          showToast={showToast}
        />
      )}

      <DeleteWorkspaceDialog
        workspaceName={workspaceToDelete}
        open={workspaceToDelete !== null}
        onClose={() => setWorkspaceToDelete(null)}
        onConfirm={confirmDeleteWorkspace}
        onArchiveInstead={handleArchiveWorkspace}
        archived={Boolean(workspaces.find((w) => w.branchName === workspaceToDelete)?.archivedAt)}
        loading={deleteWsLoading !== null}
      />

      <ArchiveWorkspaceDialog
        workspaceName={workspaceToArchive}
        open={workspaceToArchive !== null}
        onClose={() => setWorkspaceToArchive(null)}
        onArchived={handleArchived}
      />

      <ChatDock workspaces={activeWorkspaces} />
      <ChatAttentionCards workspaces={activeWorkspaces} />

      <ToastStack
        toasts={toasts}
        onDismiss={(toastId) => setToasts((prev) => prev.filter((t) => t.id !== toastId))}
      />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppInner />
    </HashRouter>
  );
}
