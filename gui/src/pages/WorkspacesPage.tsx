import { useState, useEffect, useCallback, type ComponentProps } from 'react';
import {
  MoreVertical,
  Archive,
  ArchiveRestore,
  Copy,
  Trash2,
  FolderGit2,
  Terminal,
  Code2,
  ChevronDown,
  Sparkles,
  ArrowUpCircle,
  Puzzle,
  GitCompare,
  MessagesSquare,
  Workflow,
  Zap,
  Building2,
  Tag,
  ShieldCheck,
  Edit3,
  Check,
  Plus,
  SlidersHorizontal,
  RotateCcw,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Columns2,
} from 'lucide-react';
import { VscVscode, VscVscodeInsiders } from 'react-icons/vsc';
import { AntigravityIcon } from '../components/icons/AntigravityIcon.js';
import type { Feature, WorkspaceStatus, RepoInfo, DomainPack, ResolvedCategoryRules } from '../types.js';
import { API_BASE } from '../lib/apiBase.js';
import { perfMark } from '../lib/perfMarks.js';
import { BRAND_NAME, LEGACY_BRAND_NAME } from '../brand.js';
import { ServiceConsole } from '../features/services/ServiceConsole.js';
import { WorkspaceHeader } from '../features/workspace-shell/WorkspaceHeader.js';
import { WorkspaceBackupNotice } from '../features/workspace-shell/WorkspaceBackupNotice.js';
import { BranchDriftNotice } from '../features/workspace-shell/BranchDriftNotice.js';
import { WorkspaceRail } from '../features/workspace-shell/WorkspaceRail.js';
import { SECTION_LABELS, visibleSection, type WorkspaceSection } from '../features/workspace-shell/destinations.js';
import { ArchivedNotice, ArchivedWorkspaceView } from '../features/workspace-shell/ArchivedWorkspaceView.js';
import { useCockpitStore, cockpitStore, upcastWorkspaceToCockpit } from '../features/cockpit/cockpitStore.js';

const renderEditorIcon = (id: string, name: string) => {
  const lower = `${id} ${name}`.toLowerCase();
  if (lower.includes('insiders')) {
    return <VscVscodeInsiders size={15} className="text-[#24C05A] shrink-0" />;
  }
  if (lower.includes('code') || lower.includes('vscode')) {
    return <VscVscode size={15} className="text-[#007ACC] shrink-0" />;
  }
  if (lower.includes('antigravity')) {
    return <AntigravityIcon className="size-3.5 shrink-0" />;
  }
  if (lower.includes('cursor')) {
    return <Sparkles size={14} className="text-purple-400 shrink-0" />;
  }
  if (lower.includes('powershell') || lower.includes('pwsh')) {
    return <Terminal size={14} className="text-info-foreground shrink-0" />;
  }
  if (lower.includes('cmd') || lower.includes('command prompt')) {
    return <Terminal size={14} className="text-warning-foreground shrink-0" />;
  }
  return <Code2 size={14} className="shrink-0" />;
};

import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.js';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu.js';
import { Spinner } from '../components/ui/spinner.js';
import { AddRepoPicker } from '../components/AddRepoPicker.js';
import {
  useConfig,
  useWorkspaceLaunchTargets,
  useWorkspaceSkills,
  useSkills,
  useDomainPacks,
  useCreateDomainPack,
  useSaveDomainPack,
  useDeleteDomainPack,
  useWorkspaceLifecycle,
  useWorkspaceRepositories,
  useWorkGuidance,
} from '../lib/api/queries.js';
import { repoName } from '../lib/status.js';
import { apiFetch } from '../lib/api/client.js';
import { cn } from '../lib/utils.js';
import { SessionHistory } from '../features/sessions/SessionHistory.js';
import { IconButton } from '../components/ui/icon-button.js';
import { useFloatingChat } from '../features/chat/floatingChatStore.js';
import { ChatDockSlot } from '../features/chat/ChatDockSlot.js';
import { CHAT_LAYOUT, chatLayout, hasRoomBeside, useChatLayout } from '../features/chat/chatLayout.js';
import { useElementWidth } from '../lib/useElementWidth.js';
import { CodeSection } from '../features/changes/CodeSection.js';
import { KnowledgeBase } from '../features/knowledge/KnowledgeBase.js';
import { ImplementationPlan } from '../features/plan/ImplementationPlan.js';
import { RootDocumentsPanel } from '../features/work-guidance/RootDocumentsPanel.js';
import { WorkspaceWorkPanel } from '../features/work-guidance/WorkspaceWorkPanel.js';
import { WorkspaceSkillsTab } from '../features/skills/WorkspaceSkillsTab.js';
import { ChatMarkdown } from '../components/ChatMarkdown.js';

type SubTab = WorkspaceSection;

// Per workspace, the sections already opened. Module scope keeps them across route changes in a session.
const visitedByWorkspace = new Map<string, Set<WorkspaceSection>>();
function workspaceMemory<T>(store: Map<string, T>, id: string, create: () => T): T {
  let value = store.get(id);
  if (!value) { value = create(); store.set(id, value); }
  return value;
}

interface WorkspacesPageProps {
  workspaces: Feature[];
  workspaceStatuses: Record<string, WorkspaceStatus>;
  workspacesLoading?: boolean;
  fetchWorkspaces?: () => Promise<void>;
  selectedId: string | null;
  subTab: SubTab;
  onSelect?: (id: string) => void;
  onSelectTab: (id: string, tab: SubTab) => void;
  handleCopyPrompt: (ws: Feature) => void;
  handleDeleteWorkspace: (wsName: string) => Promise<void>;
  /** Opens the archive dialog for a workspace. */
  handleArchiveWorkspace?: (wsName: string) => void;
  /** Restores an archived workspace as active. */
  handleUnarchiveWorkspace?: (wsName: string) => Promise<void>;
  deleteWsLoading: string | null;
  repos: RepoInfo[];
  addRepoLoading: boolean;
  handleAddRepo: (wsName: string, repoPath: string) => Promise<void>;
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
  sessionProps: Omit<ComponentProps<typeof SessionHistory>, 'ws'>;
  /** What Code needs to commit, finish and sync, plus the change listing the overview counts files from. */
  changesProps: Omit<ComponentProps<typeof CodeSection>, 'ws' | 'active' | 'showToast'> & { gitChanges: { repoName: string; files?: unknown[] }[] };
  knowledgeProps: Omit<ComponentProps<typeof KnowledgeBase>, 'ws'>;
  planProps: ComponentProps<typeof ImplementationPlan>;
}

export function WorkspacesPage(props: WorkspacesPageProps) {
  const {
    workspaces,
    workspaceStatuses,
    selectedId,
    subTab: requestedSubTab,
    onSelectTab,
    handleCopyPrompt,
    handleDeleteWorkspace,
    handleArchiveWorkspace,
    handleUnarchiveWorkspace,
    deleteWsLoading,
    repos,
    addRepoLoading,
    handleAddRepo,
    showToast,
    sessionProps,
    changesProps,
    knowledgeProps,
    planProps,
  } = props;

  const [planVersion, setPlanVersion] = useState(0);
  const selected = workspaces.find((w) => w.branchName === selectedId) ?? null;
  // An archived workspace shows only its record; deep links elsewhere land on its overview.
  const archived = Boolean(selected?.archivedAt);
  const subTab = visibleSection(requestedSubTab, archived);
  const [restoring, setRestoring] = useState(false);
  const handleRestore = async () => {
    if (!selected || !handleUnarchiveWorkspace) return;
    setRestoring(true);
    try {
      await handleUnarchiveWorkspace(selected.branchName);
    } finally {
      setRestoring(false);
    }
  };
  const selectedBranch = selected?.branchName;
  useEffect(() => {
    if (selectedBranch) perfMark('cs:ws-header', { id: selectedBranch, tab: subTab });
  }, [selectedBranch, subTab]);
  const selectedMode = selected?.mode ?? 'worktree';
  const { open: openChat, activeTab, splitTab, setSplitTab } = useFloatingChat();
  // The chat is the centre of the screen. Other parts open as a panel beside it when there is room, and by themselves when not.
  const layout = useChatLayout();
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useElementWidth(body);
  const roomBeside = hasRoomBeside(bodyWidth);
  const dragDivider = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !body) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const bounds = body.getBoundingClientRect();
      if (bounds.width > 0) chatLayout.setPercent(((next.clientX - bounds.left) / bounds.width) * 100);
    };
    const stop = (end: PointerEvent) => {
      if (target.hasPointerCapture(end.pointerId)) target.releasePointerCapture(end.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  const [isLegacy, setIsLegacy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const cockpit = useCockpitStore();
  const { data: lifecycleData } = useWorkspaceLifecycle(selected?.branchName ?? null);
  const { data: liveRepositories } = useWorkspaceRepositories(selected?.branchName ?? null);
  const { data: workGuidance } = useWorkGuidance(selected?.branchName ?? null);
  const visitedSections = workspaceMemory(visitedByWorkspace, selected?.branchName ?? '', () => new Set<WorkspaceSection>());
  visitedSections.add(subTab);

  useEffect(() => {
    if (!selected) return;
    const st = workspaceStatuses[selected.branchName];
    const cockpitData = upcastWorkspaceToCockpit(
      selected,
      lifecycleData?.lifecycle ?? null,
      st,
      planProps?.planContent,
      lifecycleData?.report ?? null,
      liveRepositories,
    );
    cockpitStore.setWorkspaceData({
      workspaceId: selected.branchName,
      workspaceTitle: cockpitData.workspaceTitle,
      workspaceIntent: cockpitData.workspaceIntent,
      iterations: cockpitData.iterations,
      worktrees: cockpitData.worktrees,
      gateStatus: cockpitData.gateStatus,
    });
  }, [selected, workspaceStatuses, lifecycleData, liveRepositories, planProps?.planContent]);

  useEffect(() => {
    if (!selected?.branchName) {
      setIsLegacy(false);
      return;
    }
    const controller = new AbortController();
    fetch(`${API_BASE}/api/workspace/${encodeURIComponent(selected.branchName)}/migration-status`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { isLegacy: false }))
      .then((data) => {
        if (!controller.signal.aborted) setIsLegacy(Boolean(data?.isLegacy));
      })
      .catch(() => {
        if (!controller.signal.aborted) setIsLegacy(false);
      });
    return () => controller.abort();
  }, [selected?.branchName]);

  const handleMigrateWorkspace = async () => {
    if (!selected?.branchName || migrating) return;
    setMigrating(true);
    try {
      const res = await fetch(`${API_BASE}/api/workspace/${encodeURIComponent(selected.branchName)}/migrate`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Migration failed');
      showToast?.(`Workspace successfully upgraded to native ${BRAND_NAME}!`, 'success');
      setIsLegacy(false);
      props.fetchWorkspaces?.();
    } catch (e: any) {
      showToast?.(e.message || 'Failed to migrate workspace', 'error');
    } finally {
      setMigrating(false);
    }
  };

  // Active skills in this workspace
  const workspaceSkillsConfig = useWorkspaceSkills(selected?.branchName ?? null).data;
  const { data: allSkills = [] } = useSkills(selected?.branchName);
  const activeSkills = allSkills.filter((s) => workspaceSkillsConfig?.enabledSkills?.includes(s.id));

  // Enterprise domain packs, hierarchical categories, and specifications
  const [domainData, setDomainData] = useState<ResolvedCategoryRules | null>(null);
  const { data: availableDomainPacks = [] } = useDomainPacks();
  const createDomainPackMutation = useCreateDomainPack();
  const saveDomainPackMutation = useSaveDomainPack();
  const deleteDomainPackMutation = useDeleteDomainPack();
  const [editingSpec, setEditingSpec] = useState(false);
  const [specInput, setSpecInput] = useState('');
  const [savingSpec, setSavingSpec] = useState(false);

  // New Category / Trait dialog state
  const [showCreateTagModal, setShowCreateTagModal] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagId, setNewTagId] = useState('');
  const [newTagDescription, setNewTagDescription] = useState('');
  const [newTagType, setNewTagType] = useState<'vertical' | 'trait'>('vertical');
  const [newTagParent, setNewTagParent] = useState('');
  const [newTagVerifyCmd, setNewTagVerifyCmd] = useState('');
  const [newTagRules, setNewTagRules] = useState('');
  const [newTagMicroserviceName, setNewTagMicroserviceName] = useState('');
  const [newTagMicroserviceTarget, setNewTagMicroserviceTarget] = useState<'edit' | 'reference'>('edit');
  const [savingNewTag, setSavingNewTag] = useState(false);

  // Inspect / Edit Existing Category / Trait dialog state
  const [inspectingTag, setInspectingTag] = useState<DomainPack | null>(null);
  const [inspectTagName, setInspectTagName] = useState('');
  const [inspectTagDescription, setInspectTagDescription] = useState('');
  const [inspectTagType, setInspectTagType] = useState<'vertical' | 'trait'>('vertical');
  const [inspectTagParent, setInspectTagParent] = useState('');
  const [inspectTagVerifyCmd, setInspectTagVerifyCmd] = useState('');
  const [inspectTagRules, setInspectTagRules] = useState('');
  const [inspectTagMicroservices, setInspectTagMicroservices] = useState<Array<{ name: string; target: 'edit' | 'reference' }>>([]);
  const [inspectNewMsName, setInspectNewMsName] = useState('');
  const [inspectNewMsTarget, setInspectNewMsTarget] = useState<'edit' | 'reference'>('edit');
  const [inspectTagSkills, setInspectTagSkills] = useState<string[]>([]);
  const [inspectNewSkill, setInspectNewSkill] = useState('');
  const [inspectTagTags, setInspectTagTags] = useState('');
  const [savingTagDetails, setSavingTagDetails] = useState(false);
  const [deletingTagDetails, setDeletingTagDetails] = useState(false);

  const fetchDomainData = useCallback(async (wsId: string, signal?: AbortSignal) => {
    try {
      const res = await apiFetch<any>(`/api/workspace/${encodeURIComponent(wsId)}/domain-packs`, { signal });
      // A response for a workspace the user already left must not replace the current one.
      if (res && !signal?.aborted) setDomainData(res);
    } catch {
      if (!signal?.aborted) setDomainData(null);
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setDomainData(null);
      return;
    }
    setSpecInput(selected.description || '');
    setEditingSpec(false);
    const controller = new AbortController();
    void fetchDomainData(selected.branchName, controller.signal);
    return () => controller.abort();
  }, [selected, fetchDomainData]);

  const toggleDomainPack = async (packId: string) => {
    if (!selected) return;
    const current = new Set(domainData?.assignedDomainPackIds || selected.domainPacks || []);
    if (current.has(packId)) {
      current.delete(packId);
    } else {
      current.add(packId);
    }
    const nextPacks = Array.from(current);
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(selected.branchName)}/domain-packs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainPacks: nextPacks,
        }),
      });
      await fetchDomainData(selected.branchName);
      if (props.fetchWorkspaces) await props.fetchWorkspaces();
      showToast?.(`Updated domain packs (${nextPacks.length} active)`, 'success');
    } catch {
      showToast?.('Failed to update domain packs', 'error');
    }
  };

  const handleSaveSpec = async () => {
    if (!selected || !specInput.trim()) return;
    setSavingSpec(true);
    try {
      const res = await apiFetch<any>(`/api/workspace/${encodeURIComponent(selected.branchName)}/update-spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: specInput.trim(),
          autoMatchDomains: true,
        }),
      });
      setEditingSpec(false);
      await fetchDomainData(selected.branchName);
      if (props.fetchWorkspaces) await props.fetchWorkspaces();
      if (res?.newlyMatched?.length > 0) {
        showToast?.(`Specification saved! Auto-attached domain packs: ${res.newlyMatched.join(', ')}`, 'success');
      } else {
        showToast?.('Specification updated and context refreshed', 'success');
      }
    } catch {
      showToast?.('Failed to update specification', 'error');
    } finally {
      setSavingSpec(false);
    }
  };

  const handleCreateDomainPack = async () => {
    if (!newTagId.trim() || !newTagName.trim()) return;
    setSavingNewTag(true);
    try {
      const rulesArray = newTagRules
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean);
      const microservicesArray = newTagMicroserviceName.trim()
        ? [{ name: newTagMicroserviceName.trim(), target: newTagMicroserviceTarget }]
        : undefined;

      await createDomainPackMutation.mutateAsync({
        id: newTagId.trim().toLowerCase(),
        name: newTagName.trim(),
        description: newTagDescription.trim(),
        categoryType: newTagType,
        parent: newTagType === 'vertical' && newTagParent.trim() ? newTagParent.trim() : undefined,
        verifyCommand: newTagVerifyCmd.trim() || undefined,
        rules: rulesArray.length > 0 ? rulesArray : undefined,
        microservices: microservicesArray,
        tags: [newTagId.trim().toLowerCase(), ...newTagName.trim().toLowerCase().split(/\s+/).filter(Boolean)],
      });

      if (selected) {
        await toggleDomainPack(newTagId.trim().toLowerCase());
      }

      setShowCreateTagModal(false);
      setNewTagId('');
      setNewTagName('');
      setNewTagDescription('');
      setNewTagParent('');
      setNewTagVerifyCmd('');
      setNewTagRules('');
      setNewTagMicroserviceName('');
      showToast?.(`Created category "${newTagName}" and attached to workspace!`, 'success');
    } catch (err: any) {
      showToast?.(err.message || 'Failed to create category tag', 'error');
    } finally {
      setSavingNewTag(false);
    }
  };

  const handleOpenTagDetails = (tag: DomainPack) => {
    setInspectingTag(tag);
    setInspectTagName(tag.name || '');
    setInspectTagDescription(tag.description || '');
    setInspectTagType(tag.categoryType || 'vertical');
    setInspectTagParent(tag.parent || '');
    setInspectTagVerifyCmd(tag.verifyCommand || '');
    setInspectTagRules(tag.rules ? tag.rules.join('\n') : '');
    const msList: Array<{ name: string; target: 'edit' | 'reference' }> = tag.microservices
      ? tag.microservices.map((m) => ({ name: m.name, target: m.target || 'edit' }))
      : tag.defaultRepos
        ? tag.defaultRepos.map((r) => ({ name: r, target: 'edit' as const }))
        : [];
    setInspectTagMicroservices(msList);
    setInspectNewMsName('');
    setInspectNewMsTarget('edit');
    setInspectTagSkills(tag.skills ? [...tag.skills] : []);
    setInspectNewSkill('');
    setInspectTagTags(tag.tags ? tag.tags.join(', ') : '');
  };

  const handleSaveTagDetails = async () => {
    if (!inspectingTag || !inspectTagName.trim()) return;
    setSavingTagDetails(true);
    try {
      const rulesArray = inspectTagRules
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean);
      const tagsArray = inspectTagTags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      const payload = {
        id: inspectingTag.id,
        name: inspectTagName.trim(),
        description: inspectTagDescription.trim(),
        categoryType: inspectTagType,
        parent: inspectTagType === 'vertical' ? inspectTagParent.trim() : '',
        verifyCommand: inspectTagVerifyCmd.trim(),
        rules: rulesArray,
        microservices: inspectTagMicroservices,
        skills: inspectTagSkills,
        tags: tagsArray.length > 0 ? tagsArray : [inspectingTag.id],
      };

      await saveDomainPackMutation.mutateAsync(payload);

      if (selected) {
        await fetchDomainData(selected.branchName);
        if (props.fetchWorkspaces) await props.fetchWorkspaces();
      }

      showToast?.(`Tag "${inspectTagName.trim()}" updated successfully`, 'success');
      setInspectingTag(null);
    } catch (err: any) {
      showToast?.(err.message || 'Failed to update tag', 'error');
    } finally {
      setSavingTagDetails(false);
    }
  };

  const handleDeleteOrResetTag = async () => {
    if (!inspectingTag) return;
    const isOverriddenBuiltin = Boolean(inspectingTag.builtin && !inspectingTag.isTemplate);
    const actionLabel = isOverriddenBuiltin ? 'reset to built-in template' : 'delete';
    if (!window.confirm(`Are you sure you want to ${actionLabel} the tag "${inspectingTag.name}"?`)) {
      return;
    }
    setDeletingTagDetails(true);
    try {
      await deleteDomainPackMutation.mutateAsync(inspectingTag.id);

      if (selected) {
        const currentPacks = domainData?.assignedDomainPackIds || selected.domainPacks || [];
        if (!isOverriddenBuiltin && currentPacks.includes(inspectingTag.id)) {
          const updatedPacks = currentPacks.filter((p) => p !== inspectingTag.id);
          await apiFetch(`/api/workspace/${encodeURIComponent(selected.branchName)}/domain-packs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              domainPacks: updatedPacks,
            }),
          });
        }
        await fetchDomainData(selected.branchName);
        if (props.fetchWorkspaces) await props.fetchWorkspaces();
      }

      showToast?.(isOverriddenBuiltin ? `Reset "${inspectingTag.name}" to built-in defaults` : `Deleted tag "${inspectingTag.name}"`, 'success');
      setInspectingTag(null);
    } catch (err: any) {
      showToast?.(err.message || 'Failed to delete/reset tag', 'error');
    } finally {
      setDeletingTagDetails(false);
    }
  };

  const { gitChanges: overviewChanges, ...codeSectionProps } = changesProps;
  const repoRows = selected
    ? selected.repos.map((rp) => {
        const name = repoName(rp);
        const change = overviewChanges?.find((c: { repoName: string; files?: unknown[] }) => c.repoName === name);
        const changedCount: number | null = change ? change.files?.length ?? 0 : null;
        return { name, path: rp, changedCount };
      })
    : [];

  const availableRepos = selected ? repos.filter((r) => !selected.repos.includes(r.path)) : [];

  const launchTargets = useWorkspaceLaunchTargets();
  const config = useConfig().data?.config;
  const [openingEditor, setOpeningEditor] = useState<string | null>(null);

  const availableEditors = launchTargets.data?.filter((t) => t.kind === 'editor' && t.available) ?? [];
  const preferredEditorId = config?.defaultEditor
    ? ({
        code: 'vscode',
        vscode: 'vscode',
        'code-insiders': 'vscode-insiders',
        'vscode-insiders': 'vscode-insiders',
        cursor: 'cursor',
        antigravity: 'antigravity',
        idea: 'intellij',
        intellij: 'intellij',
        webstorm: 'webstorm',
        charm: 'pycharm',
        pycharm: 'pycharm',
        subl: 'sublime',
        sublime: 'sublime',
        zed: 'zed',
        windsurf: 'windsurf',
      } as Record<string, string>)[config.defaultEditor] || config.defaultEditor
    : undefined;

  const primaryEditor = (preferredEditorId ? availableEditors.find((e) => e.id === preferredEditorId) : undefined)
    || availableEditors.find((e) => e.id === 'vscode-insiders')
    || availableEditors.find((e) => e.id === 'vscode')
    || availableEditors[0];

  const handleOpenEditor = async (targetId: string) => {
    if (openingEditor || !selected) return;
    setOpeningEditor(targetId);
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(selected.branchName)}/launch`, {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
      showToast?.(`Opened workspace in ${targetId}.`, 'success');
    } catch (e) {
      showToast?.(`Failed to open ${targetId}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setOpeningEditor(null);
    }
  };

  const renderInspector = () => {
    if (!selected) return null;
    const st = workspaceStatuses[selected.branchName];
    const totalChangedFiles = st?.changedFiles ?? 0;
    const showPanel = subTab !== 'chat';
    const showChat = !archived && (subTab === 'chat' || (roomBeside && !layout.hidden));

    const panelActions = <>
      {roomBeside && !archived && (
        <IconButton
          size="sm"
          label={layout.hidden ? 'Show the chat beside this' : 'Hide the chat and give this the whole width'}
          icon={layout.hidden ? <PanelLeftOpen /> : <PanelLeftClose />}
          onClick={() => chatLayout.toggleHidden()}
        />
      )}
      {!archived && <IconButton size="sm" label="Close this panel and give the chat the whole screen" icon={<X />} onClick={() => onSelectTab(selected.branchName, 'chat')} />}
    </>;

    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col w-full">
        <WorkspaceHeader
          compact={showChat}
          workspaceId={selected.branchName}
          title={selected.name || selected.branchName}
          branchName={selected.name ? selected.branchName : undefined}
          brief={cockpit.workspaceIntent || selected.description}
          mode={selectedMode}
          repoCount={selected.repos.length}
          changedFiles={st ? totalChangedFiles : null}
          stage={workGuidance?.assignment.stage}
          milestones={lifecycleData?.lifecycle?.steps ?? []}
          verification={cockpit.gateStatus}
          actions={<>
              {primaryEditor && !archived && (
                availableEditors.length > 1 ? (
                  <div className="inline-flex h-7 items-center rounded-md text-xs">
                    <button
                      type="button"
                      disabled={Boolean(openingEditor)}
                      onClick={() => void handleOpenEditor(primaryEditor.id)}
                      title={`Open in ${primaryEditor.name}`}
                      aria-label={`Open in ${primaryEditor.name}`}
                      className="inline-flex h-full items-center px-1.5 text-foreground hover:bg-accent transition-colors cursor-pointer rounded-l-md disabled:opacity-50"
                    >
                      {openingEditor === primaryEditor.id ? <Spinner className="size-3.5" /> : renderEditorIcon(primaryEditor.id, primaryEditor.name)}
                    </button>
                    <Menu>
                      <MenuTrigger aria-label="Choose editor" className="inline-flex h-full w-6 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer rounded-r-md">
                        <ChevronDown size={11} />
                      </MenuTrigger>
                      <MenuPopup align="end" className="w-52">
                        <div className="px-2 py-1 text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                          Open in Editor
                        </div>
                        {availableEditors.map((ed) => (
                          <MenuItem
                            key={ed.id}
                            onClick={() => void handleOpenEditor(ed.id)}
                            className={cn(
                              'flex items-center justify-between text-xs py-1.5',
                              ed.id === primaryEditor.id && 'font-bold text-primary bg-primary/5'
                            )}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {renderEditorIcon(ed.id, ed.name)}
                              <span className="truncate">{ed.name}</span>
                            </div>
                            {ed.id === primaryEditor.id && <span className="text-[10px] text-primary font-mono">(default)</span>}
                          </MenuItem>
                        ))}
                      </MenuPopup>
                    </Menu>
                  </div>
                ) : (
                  <IconButton
                    size="sm"
                    label={`Open in ${primaryEditor.name}`}
                    disabled={Boolean(openingEditor)}
                    onClick={() => void handleOpenEditor(primaryEditor.id)}
                    icon={openingEditor === primaryEditor.id ? <Spinner className="size-3.5" /> : renderEditorIcon(primaryEditor.id, primaryEditor.name)}
                  />
                )
              )}

              <IconButton size="sm" label="Copy Context" icon={<Copy />} onClick={() => handleCopyPrompt(selected)} className="text-muted-foreground hover:text-foreground" />

              {/* A second workspace docks beside the chat on screen, so only that workspace offers it. */}
              {!archived && activeTab === selected.branchName && (
                <Menu>
                  <MenuTrigger
                    aria-label="Dock a second workspace"
                    className={cn(
                      'grid size-7 place-items-center rounded-md transition-colors cursor-pointer',
                      splitTab ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                    title="Show a second workspace beside this one"
                  >
                    <Columns2 size={13} />
                  </MenuTrigger>
                  <MenuPopup align="end" className="max-h-72 w-56 overflow-y-auto p-1.5">
                    {splitTab && (
                      <MenuItem onClick={() => setSplitTab(null)} className="text-xs">
                        Close docked workspace
                      </MenuItem>
                    )}
                    {workspaces
                      .filter((workspace) => workspace.branchName !== selected.branchName)
                      .map((workspace) => (
                        <MenuItem
                          key={workspace.branchName}
                          onClick={() => setSplitTab(workspace.branchName)}
                          className="flex items-center gap-2 text-xs"
                        >
                          <FolderGit2 className="size-3" />
                          <span className="truncate">{workspace.name || workspace.branchName}</span>
                          {splitTab === workspace.branchName && (
                            <span className="ml-auto text-primary font-medium">Docked</span>
                          )}
                        </MenuItem>
                      ))}
                    {workspaces.length < 2 && (
                      <p className="p-2 text-xs text-muted-foreground">
                        Open another workspace to dock it here.
                      </p>
                    )}
                  </MenuPopup>
                </Menu>
              )}

              <Menu>
                <MenuTrigger aria-label="Workspace actions" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer">
                  <MoreVertical size={13} />
                </MenuTrigger>
                <MenuPopup align="end" className="w-48">
                  <MenuItem onClick={() => handleCopyPrompt(selected)} className="flex items-center gap-2 text-xs py-1.5">
                    <Copy size={12} /> <span>Copy AI Context</span>
                  </MenuItem>
                  {archived ? (
                    handleUnarchiveWorkspace && (
                      <MenuItem onClick={() => void handleRestore()} disabled={restoring} className="flex items-center gap-2 text-xs py-1.5">
                        <ArchiveRestore size={12} /> <span>{restoring ? 'Restoring…' : 'Restore workspace'}</span>
                      </MenuItem>
                    )
                  ) : (
                    handleArchiveWorkspace && (
                      <MenuItem onClick={() => handleArchiveWorkspace(selected.branchName)} className="flex items-center gap-2 text-xs py-1.5">
                        <Archive size={12} /> <span>Archive workspace…</span>
                      </MenuItem>
                    )
                  )}
                  <MenuItem
                    onClick={() => void handleDeleteWorkspace(selected.branchName)}
                    disabled={deleteWsLoading === selected.branchName}
                    className="flex items-center gap-2 text-xs py-1.5 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 size={12} />
                    <span>{deleteWsLoading === selected.branchName ? 'Deleting…' : 'Delete workspace…'}</span>
                  </MenuItem>
                </MenuPopup>
              </Menu>
          </>}
        />
        {!archived && <WorkspaceBackupNotice workspaceId={selected.branchName} />}
        {!archived && <BranchDriftNotice workspaceId={selected.branchName} />}
        {/* Tab Navigation & Content Container */}
        <div ref={setBody} className="flex min-h-0 flex-1 pb-14 md:pb-0">
          {showChat && (
            <div className="h-full min-h-0 min-w-0" style={{ flex: showPanel ? `0 0 ${layout.percent}%` : '1 1 100%' }}>
              {/* The chat is not rendered here: it lives above the router and sits over this box, so it stays alive. */}
              <ChatDockSlot />
            </div>
          )}
          {showChat && showPanel && (
            <div
              role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize the chat"
              aria-valuemin={CHAT_LAYOUT.minPercent} aria-valuemax={CHAT_LAYOUT.maxPercent} aria-valuenow={layout.percent}
              className="group z-10 -mx-0.5 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-border/60 hover:bg-primary/40 focus-visible:bg-primary/50 focus-visible:outline-hidden"
              title="Drag, or use the arrow keys, to give the chat more or less room"
              onPointerDown={dragDivider}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                // From the stored width, not the rendered one: a held key repeats faster than the page renders.
                chatLayout.setPercent(chatLayout.get().percent + (event.key === 'ArrowRight' ? 3 : -3));
              }}
            />
          )}
          {showPanel && (
          <div className="relative flex min-w-0 flex-1 flex-col">
            {/* What is open, and the way back to the chat, which is always one click: the cross, or the rail item again.
                Code and Docs carry these in their own toolbars, so each spends one row on controls instead of two. */}
            {subTab !== 'changes' && subTab !== 'documents' && (
            <div className="z-10 flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-background/95 px-6 py-1.5 backdrop-blur">
              {/* A label, not a heading: the part below names itself, and its region carries the same name. */}
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{SECTION_LABELS[subTab]}</p>
              {panelActions}
            </div>
            )}
          {/* Code fills the panel: its tree and its file scroll on their own, so it is not inside the page's scroll.
              It stays mounted once opened, so going to the plan and back keeps the open file and the folders. */}
          {visitedSections.has('changes') && !archived && (
            <div role="region" aria-label={SECTION_LABELS.changes} hidden={subTab !== 'changes'} className="min-h-0 flex-1">
              <CodeSection key={selected.branchName} ws={selected} active={subTab === 'changes'} {...codeSectionProps} showToast={showToast} panelActions={panelActions} />
            </div>
          )}
          {visitedSections.has('documents') && (
            <div role="region" aria-label={SECTION_LABELS.documents} hidden={subTab !== 'documents'} className="min-h-0 flex-1">
              <RootDocumentsPanel key={selected.branchName} workspaceId={selected.branchName} workspacePath={selected.workspacePath} panelActions={panelActions} />
            </div>
          )}
          <div hidden={subTab === 'changes' || subTab === 'documents'} className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pb-12 pt-5">
          {/* Legacy Migration Alert Banner */}
          {isLegacy && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-transparent p-3 backdrop-blur-md shadow-xs">
              <div className="flex items-center gap-2.5 text-xs text-amber-200">
                <Sparkles size={16} className="text-warning-foreground shrink-0 animate-pulse" />
                <span>
                  <strong className="font-semibold text-warning-foreground">Legacy {LEGACY_BRAND_NAME} Workspace:</strong> Upgrade to native {BRAND_NAME} manifest and synchronized artifacts.
                </span>
              </div>
              <button
                type="button"
                onClick={handleMigrateWorkspace}
                disabled={migrating}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                <ArrowUpCircle size={14} className={migrating ? 'animate-spin' : ''} />
                {migrating ? 'Upgrading...' : `Migrate to ${BRAND_NAME}`}
              </button>
            </div>
          )}

          {archived && <ArchivedNotice workspace={selected} onRestore={() => void handleRestore()} restoring={restoring} />}

          <div role="region" aria-label={SECTION_LABELS[subTab]} className="pb-6">
              {subTab === 'overview' && archived && <ArchivedWorkspaceView workspace={selected} />}
              {subTab === 'overview' && !archived && (
                <div className="flex flex-col gap-6">
                  {/* HIGH-DENSITY TELEMETRY STRIP */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {/* Stat 1: Git Status */}
                    <div
                      onClick={() => onSelectTab(selected.branchName, 'changes')}
                      className="px-4 py-3 rounded-xl border border-border/80 bg-card/70 hover:bg-card hover:border-primary/40 transition-all cursor-pointer shadow-xs flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary shrink-0 border border-primary/20">
                          <GitCompare size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Git Status</div>
                          <div className="text-sm font-extrabold font-mono text-foreground truncate">
                            {totalChangedFiles > 0 ? (
                              <span className="text-warning-foreground">{totalChangedFiles} Modified</span>
                            ) : (
                              <span className="text-success-foreground">Clean Tree</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">{selected.repos.length} {selected.repos.length === 1 ? 'repo' : 'repos'}</span>
                    </div>

                    {/* Stat 2: Flow Mode */}
                    <div className="px-4 py-3 rounded-xl border border-border/80 bg-card/70 shadow-xs flex items-center justify-between">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary shrink-0 border border-primary/20">
                          <Workflow size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Flow Mode</div>
                          <div className="text-sm font-extrabold text-foreground capitalize flex items-center gap-1.5 truncate">
                            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                            {selected.flowType ? selected.flowType.replace('-', ' ') : 'Feature Flow'}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground capitalize">{selectedMode}</span>
                    </div>

                    {/* Stat 3: AI Assistant */}
                    <div
                      onClick={() => onSelectTab(selected.branchName, 'sessions')}
                      className="px-4 py-3 rounded-xl border border-border/80 bg-card/70 hover:bg-card hover:border-primary/40 transition-all cursor-pointer shadow-xs flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary shrink-0 border border-primary/20">
                          <MessagesSquare size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">AI Assistant</div>
                          <div className="text-sm font-extrabold text-foreground capitalize truncate">
                            {selected.assistants[0] || 'None chosen'}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">Sessions</span>
                    </div>

                    {/* Stat 4: Attached Skills */}
                    <div
                      onClick={() => onSelectTab(selected.branchName, 'skills')}
                      className="px-4 py-3 rounded-xl border border-border/80 bg-card/70 hover:bg-card hover:border-primary/40 transition-all cursor-pointer shadow-xs flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary shrink-0 border border-primary/20">
                          <Puzzle size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Skills Active</div>
                          <div className="text-sm font-extrabold font-mono text-foreground truncate">
                            {activeSkills.length} <span className="text-xs font-semibold text-muted-foreground">toolkits</span>
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground">Manage</span>
                    </div>
                  </div>

                  {/* MAIN COMMAND CENTER: 2-COLUMN UNIFIED COCKPIT */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* PRIMARY COLUMN (7 cols): FLOW PIPELINE & IMPLEMENTATION PLAN */}
                    <div className="lg:col-span-7 space-y-6">
                      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
                        <h3 className="font-semibold">Plan, assignment & source documents</h3>
                        <p className="text-sm text-muted-foreground">Set the current AI stage, attach requirements, and manage milestone progress in one place.</p>
                        <Button onClick={() => onSelectTab(selected.branchName, 'plan')}>Open plan & sources</Button>
                      </div>
                    </div>

                    {/* CONTEXT & OPERATIONS COLUMN (5 cols) */}
                    <div className="lg:col-span-5 space-y-6">
                      {/* SECTION: MAPPED REPOSITORIES LIVE MATRIX */}
                      <Card className="border-border/80 bg-card/70 backdrop-blur-md rounded-xl overflow-hidden shadow-xs">
                        <div className="flex items-center justify-between p-4 border-b border-border/60 bg-muted/20">
                          <div className="flex items-center gap-2.5">
                            <FolderGit2 size={16} className="text-primary" />
                            <h3 className="text-xs font-extrabold uppercase tracking-wider text-foreground">
                              Mapped Repositories ({selected.repos.length})
                            </h3>
                          </div>
                          {availableRepos.length > 0 && (
                            <AddRepoPicker
                              repos={availableRepos}
                              disabled={addRepoLoading}
                              onAdd={(repoPath: string) => {
                                if (
                                  window.confirm(
                                    `Add repository "${repoName(repoPath)}" to this workspace?\nThis creates a new git worktree and re-runs analysis.`,
                                  )
                                ) {
                                  void handleAddRepo(selected.branchName, repoPath);
                                }
                              }}
                            />
                          )}
                        </div>

                        <div className="divide-y divide-border/60">
                          {repoRows.map((r) => (
                            <div key={r.name} className="flex items-center justify-between p-3.5 hover:bg-accent/40 transition-colors text-xs">
                              <div className="flex items-center gap-3 min-w-0">
                                <span
                                  className={cn(
                                    'size-2.5 rounded-full shrink-0 shadow-xs',
                                    r.changedCount === null ? 'bg-muted-foreground' : r.changedCount > 0 ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400',
                                  )}
                                  title={r.changedCount === null ? 'Status unknown' : r.changedCount > 0 ? `${r.changedCount} uncommitted changes` : 'Clean'}
                                />
                                <div className="min-w-0">
                                  <div className="font-mono font-bold text-foreground text-xs sm:text-sm truncate">
                                    {r.name}
                                  </div>
                                  <div className="font-mono text-[10px] text-muted-foreground truncate max-w-xs">
                                    {r.path}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className={cn(
                                  'font-mono text-[10px] font-semibold px-2 py-0.5 rounded-md border',
                                  r.changedCount === null
                                    ? 'border-border bg-muted/60 text-muted-foreground'
                                    : r.changedCount > 0
                                    ? 'border-amber-500/30 bg-amber-500/10 text-warning-foreground'
                                    : 'border-emerald-500/30 bg-emerald-500/10 text-success-foreground'
                                )}>
                                  {r.changedCount === null ? '—' : r.changedCount > 0 ? `${r.changedCount} mod` : 'Clean'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Card>

                      {/* SECTION: ENTERPRISE CONTEXT, DOMAIN PACKS & FEATURE SPEC (optional, collapsed) */}
                      <details className="group rounded-xl border border-border/80 bg-card/70 shadow-xs">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                          <span>Domain context and category rules <span className="font-normal text-muted-foreground">— optional</span></span>
                          <ChevronDown aria-hidden="true" size={14} className="text-muted-foreground transition-transform group-open:rotate-180" />
                        </summary>
                      <Card className="p-4 border-0 border-t border-border/60 bg-transparent rounded-none rounded-b-xl shadow-none space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Zap size={14} className="text-primary" />
                            <h4 className="text-xs font-extrabold uppercase tracking-wider text-foreground">
                              Task brief & category rules
                            </h4>
                          </div>
                          {!editingSpec ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => {
                                setSpecInput(selected.description || '');
                                setEditingSpec(true);
                              }}
                              className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                            >
                              <Edit3 size={11} />
                              <span>Edit brief</span>
                            </Button>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setEditingSpec(false)}
                                className="h-6 px-2 text-[11px] text-muted-foreground"
                                disabled={savingSpec}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                onClick={() => void handleSaveSpec()}
                                className="h-6 px-2.5 text-[11px] gap-1 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
                                disabled={savingSpec}
                              >
                                {savingSpec ? <Spinner size="sm" /> : <Check size={11} />}
                                <span>Save & Match</span>
                              </Button>
                            </div>
                          )}
                        </div>

                        {/* ENTERPRISE ORGANIZATION & DOMAIN PACK BADGES */}
                        <div className="space-y-2 pt-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {/* Organization Root Badge (if configured) */}
                              {domainData?.organization && (
                                <div
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border border-purple-500/30 bg-purple-500/10 text-purple-300 shadow-xs"
                                  title={`Universal Root Conventions: ${domainData.organization.name}. Commit pattern: ${domainData.organization.commitMessagePattern}`}
                                >
                                  <Building2 size={11} className="text-purple-400 shrink-0" />
                                  <span>{domainData.organization.name} Root</span>
                                  <span className="text-[9px] px-1 py-0.2 rounded bg-purple-500/20 text-purple-200 font-mono">Conventions</span>
                                </div>
                              )}

                              {/* Empty State */}
                              {availableDomainPacks.length === 0 && !domainData?.organization && (
                                <span className="text-xs text-muted-foreground italic py-1">
                                  No category or trait tags defined yet.
                                </span>
                              )}

                              {/* Subsystem Verticals (Grouped with Children) */}
                              {availableDomainPacks
                                .filter((p) => p.categoryType !== 'trait' && (!p.parent || !availableDomainPacks.some((parent) => parent.id === p.parent)))
                                .map((root) => {
                                  const isRootAssigned = (domainData?.assignedDomainPackIds || selected.domainPacks || []).includes(root.id);
                                  const children = availableDomainPacks.filter((c) => c.parent === root.id);
                                  return (
                                    <div key={root.id} className="inline-flex items-center rounded-lg border border-border/60 bg-muted/20 p-0.5 gap-1">
                                      <div className="inline-flex items-center">
                                        <button
                                          type="button"
                                          onClick={() => void toggleDomainPack(root.id)}
                                          className={cn(
                                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-l-md text-xs font-medium transition-all cursor-pointer',
                                            isRootAssigned
                                              ? 'bg-emerald-500/20 text-success-foreground font-semibold shadow-xs'
                                              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                                          )}
                                          title={`${root.name}: ${root.description} (Click to toggle)`}
                                        >
                                          <Tag size={10} className={isRootAssigned ? 'text-success-foreground' : 'text-muted-foreground'} />
                                          <span>{root.name}</span>
                                          {!root.isTemplate && (
                                            <span className="text-[8px] px-1 py-0.2 rounded bg-amber-500/20 text-warning-foreground font-mono">custom</span>
                                          )}
                                          {isRootAssigned ? (
                                            <span className="size-1.5 rounded-full bg-emerald-400" />
                                          ) : (
                                            <Plus size={10} className="opacity-50" />
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleOpenTagDetails(root);
                                          }}
                                          className={cn(
                                            'px-1 py-1 rounded-r-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer',
                                            isRootAssigned ? 'bg-emerald-500/20 text-success-foreground/80 hover:text-emerald-200' : '',
                                          )}
                                          title={`Inspect & edit ${root.name} details`}
                                          aria-label={`Inspect & edit ${root.name} details`}
                                        >
                                          <SlidersHorizontal size={10} />
                                        </button>
                                      </div>
                                      {children.map((child) => {
                                        const isChildAssigned = (domainData?.assignedDomainPackIds || selected.domainPacks || []).includes(child.id);
                                        return (
                                          <div key={child.id} className="inline-flex items-center">
                                            <button
                                              type="button"
                                              onClick={() => void toggleDomainPack(child.id)}
                                              className={cn(
                                                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-l-md text-[11px] font-medium transition-all cursor-pointer border-y border-l',
                                                isChildAssigned
                                                  ? 'border-emerald-500/40 bg-emerald-500/25 text-emerald-200 font-semibold shadow-xs'
                                                  : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                                              )}
                                              title={`${child.name} (Inherits ${root.name}): ${child.description} (Click to toggle)`}
                                            >
                                              <span className="text-muted-foreground text-[10px]">↳</span>
                                              <span>{child.name.replace(/^.*\s*›\s*/, '')}</span>
                                              {!child.isTemplate && (
                                                <span className="text-[8px] px-1 py-0.2 rounded bg-amber-500/20 text-warning-foreground font-mono">custom</span>
                                              )}
                                              {isChildAssigned ? (
                                                <span className="size-1.5 rounded-full bg-emerald-400" />
                                              ) : (
                                                <Plus size={9} className="opacity-50" />
                                              )}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleOpenTagDetails(child);
                                              }}
                                              className={cn(
                                                'px-1 py-1 rounded-r-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer border-y border-r',
                                                isChildAssigned ? 'border-emerald-500/40 bg-emerald-500/25 text-emerald-200/80 hover:text-emerald-100' : 'border-transparent',
                                              )}
                                              title={`Inspect & edit ${child.name} details`}
                                              aria-label={`Inspect & edit ${child.name} details`}
                                            >
                                              <SlidersHorizontal size={9} />
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })}

                              {/* Horizontal Traits */}
                              {availableDomainPacks
                                .filter((p) => p.categoryType === 'trait')
                                .map((trait) => {
                                  const isAssigned = (domainData?.assignedDomainPackIds || selected.domainPacks || []).includes(trait.id);
                                  return (
                                    <div
                                      key={trait.id}
                                      className={cn(
                                        'inline-flex items-center rounded-lg border transition-all p-0.5 gap-0.5',
                                        isAssigned
                                          ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300 shadow-xs'
                                          : 'border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                                      )}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => void toggleDomainPack(trait.id)}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-l-md text-xs font-medium cursor-pointer"
                                        title={`Cross-cutting Trait: ${trait.name} - ${trait.description} (Click to toggle)`}
                                      >
                                        <ShieldCheck size={11} className={isAssigned ? 'text-indigo-400' : 'text-muted-foreground'} />
                                        <span>{trait.name}</span>
                                        <span className="text-[9px] px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-200 font-mono">Trait</span>
                                        {!trait.isTemplate && (
                                          <span className="text-[8px] px-1 py-0.2 rounded bg-amber-500/20 text-warning-foreground font-mono">custom</span>
                                        )}
                                        {isAssigned ? (
                                          <span className="size-1.5 rounded-full bg-indigo-400" />
                                        ) : (
                                          <Plus size={10} className="opacity-50" />
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleOpenTagDetails(trait);
                                        }}
                                        className="p-1 rounded-r-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                                        title={`Inspect & edit ${trait.name} details`}
                                        aria-label={`Inspect & edit ${trait.name} details`}
                                      >
                                        <SlidersHorizontal size={10} />
                                      </button>
                                    </div>
                                  );
                                })}
                            </div>

                            {/* Add Category Button */}
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => setShowCreateTagModal(true)}
                              className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground border border-dashed border-border/80"
                            >
                              <Plus size={11} />
                              <span>New Category / Trait</span>
                            </Button>
                          </div>

                          {/* SCOPED MICROSERVICES CONTAINER */}
                          {((domainData?.editRepos && domainData.editRepos.length > 0) ||
                            (domainData?.referenceRepos && domainData.referenceRepos.length > 0)) && (
                            <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-muted/40 border border-border/60 text-xs">
                              <span className="font-semibold text-muted-foreground flex items-center gap-1 text-[11px]">
                                <FolderGit2 size={12} className="text-primary" />
                                <span>Scoped Microservices:</span>
                              </span>
                              {domainData.editRepos?.map((repo) => (
                                <span
                                  key={repo}
                                  className="px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono text-[11px] flex items-center gap-1 shadow-xs"
                                  title="Active Worktree (Edit Mode)"
                                >
                                  <Edit3 size={10} />
                                  <span>{repo}</span>
                                  <span className="text-[9px] opacity-75 font-sans font-semibold">(edit)</span>
                                </span>
                              ))}
                              {domainData.referenceRepos?.map((repo) => (
                                <span
                                  key={repo}
                                  className="px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border/80 font-mono text-[11px] flex items-center gap-1"
                                  title="Reference Mode (Read-only context)"
                                >
                                  <span>{repo}</span>
                                  <span className="text-[9px] opacity-75 font-sans">(ref)</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* SPEC CONTENT OR EDITOR */}
                        {editingSpec ? (
                          <div className="space-y-2 pt-1">
                            <textarea
                              value={specInput}
                              onChange={(e) => setSpecInput(e.target.value)}
                              rows={5}
                              placeholder="Describe the intended outcome and acceptance criteria. Attach detailed source documents in Plan."
                              className="w-full text-xs font-mono p-3 rounded-lg border border-border/80 bg-background/80 text-foreground focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed resize-y"
                            />
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Sparkles size={11} className="text-warning-foreground" />
                                <span>Auto-detects subsystem domain tags upon saving</span>
                              </span>
                              <span>{specInput.length} chars</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs leading-relaxed text-foreground/90 max-h-44 overflow-y-auto pr-1">
                            {selected.description ? (
                              <ChatMarkdown content={selected.description} />
                            ) : (
                              <div className="text-muted-foreground italic py-2">
                                No task brief yet. Add a short outcome here and attach detailed sources in Plan.
                              </div>
                            )}
                          </div>
                        )}

                        {/* ACTIVE SUBSYSTEM RULES & COMPLIANCE PREVIEW */}
                        {domainData?.allRules && domainData.allRules.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-border/50 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                <ShieldCheck size={12} className="text-success-foreground" />
                                <span>Active Rules & Verification ({domainData.allRules.length})</span>
                              </div>
                              <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                <span className="px-1 py-0.2 rounded bg-purple-500/10 text-purple-300">Org Root</span>
                                <span>›</span>
                                <span className="px-1 py-0.2 rounded bg-emerald-500/10 text-success-foreground">Verticals</span>
                                <span>›</span>
                                <span className="px-1 py-0.2 rounded bg-indigo-500/10 text-indigo-300">Traits</span>
                              </div>
                            </div>
                            <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                              {domainData.allRules.slice(0, 4).map((rule, idx) => (
                                <div key={idx} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-snug">
                                  <span className="text-primary font-bold">›</span>
                                  <span className="truncate">{rule}</span>
                                </div>
                              ))}
                              {domainData.allRules.length > 4 && (
                                <div className="text-[10px] text-muted-foreground italic pl-3">
                                  +{domainData.allRules.length - 4} more domain rules active in AGENTS.md
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </Card>
                      </details>

                      {/* SECTION: ATTACHED SKILLS */}
                      <Card className="border-border/80 bg-card/70 backdrop-blur-md rounded-xl p-4 shadow-xs">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <Puzzle size={15} className="text-primary" />
                            <h3 className="text-xs font-extrabold uppercase tracking-wider text-foreground">
                              Skills & Capabilities ({activeSkills.length})
                            </h3>
                          </div>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => onSelectTab(selected.branchName, 'skills')}
                            className="text-[11px] font-semibold gap-1 h-7"
                          >
                            <Puzzle size={11} />
                            <span>Configure</span>
                          </Button>
                        </div>
                        {activeSkills.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">No custom skills attached to this workspace.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {activeSkills.map((skill) => (
                              <span
                                key={skill.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-medium border border-border/70 bg-card/60"
                                title={skill.description}
                              >
                                <Puzzle size={10} className="text-primary" />
                                {skill.title || skill.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </Card>
                    </div>
                  </div>
                </div>
              )}
              {subTab === 'sessions' && (
                <section aria-labelledby="session-history-heading" className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-border bg-card shadow-xs">
                    <div>
                      <h2 id="session-history-heading" className="text-sm font-semibold text-foreground">
                        AI Sessions & History
                      </h2>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Inspect recorded session logs, turns, and token usage, or open active conversations in CLI chat.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => openChat(selected.branchName)}
                      className="shrink-0 cursor-pointer self-start sm:self-auto"
                      title="Open CLI chat for this workspace"
                    >
                      <MessagesSquare className="size-3.5" />
                      <span>Open CLI Chat</span>
                    </Button>
                  </div>
                  <SessionHistory ws={selected} showToast={showToast} {...sessionProps} />
                </section>
              )}
              {subTab === 'knowledge' && <KnowledgeBase ws={selected} {...knowledgeProps} readOnly={archived} />}
              {subTab === 'skills' && <WorkspaceSkillsTab ws={selected} showToast={showToast} />}
              {visitedSections.has('plan') && <div hidden={subTab !== 'plan'} className="space-y-6">
                <WorkspaceWorkPanel key={selected.branchName} workspaceId={selected.branchName} readOnly={archived} onPlanChanged={() => {
                  setPlanVersion((version) => version + 1);
                  void planProps.handleRetryPlan(selected.branchName);
                }} />
                <ImplementationPlan key={`${selected.branchName}-${planVersion}`} workspaceId={selected.branchName} defaultViewMode="flow" {...planProps} readOnly={archived} />
              </div>}
              {subTab === 'services' && <ServiceConsole ws={selected} />}
          </div>
        </div>
          </div>
          </div>
          )}
          <WorkspaceRail workspaceId={selected.branchName} section={subTab} archived={archived} badges={{ changes: totalChangedFiles, skills: activeSkills.length }} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 animate-fade-in w-full min-w-0 bg-transparent">
      {!selected ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderGit2 />
                </EmptyMedia>
                <EmptyTitle>No workspace selected</EmptyTitle>
                <EmptyDescription>
                  Select a workspace from the sidebar to inspect git changes, context, or launch AI assistants.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 h-full overflow-hidden flex flex-col">
          <div className="flex w-full flex-1 min-h-0 min-w-0 flex-col">
            {renderInspector()}
          </div>
        </div>
      )}

      {/* MODAL: CREATE NEW CATEGORY / TRAIT */}
      <Dialog open={showCreateTagModal} onOpenChange={setShowCreateTagModal}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag size={16} className="text-primary" />
              <span>Create Enterprise Category or Trait</span>
            </DialogTitle>
            <DialogDescription>
              Define a vertical business subsystem or horizontal cross-cutting trait with architectural invariants, microservice bindings, and verification commands.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3.5 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Name</label>
                <Input
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="e.g. Order Processing"
                  size="sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Tag ID / Slug</label>
                <Input
                  value={newTagId}
                  onChange={(e) => setNewTagId(e.target.value)}
                  placeholder="e.g. orders"
                  size="sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Type</label>
                <select
                  value={newTagType}
                  onChange={(e) => setNewTagType(e.target.value as 'vertical' | 'trait')}
                  className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                >
                  <option value="vertical">Vertical Subsystem</option>
                  <option value="trait">Horizontal Trait</option>
                </select>
              </div>
              {newTagType === 'vertical' && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">Parent Category (optional)</label>
                  <select
                    value={newTagParent}
                    onChange={(e) => setNewTagParent(e.target.value)}
                    className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                  >
                    <option value="">None (Top-level vertical)</option>
                    {availableDomainPacks
                      .filter((p) => p.categoryType !== 'trait' && !p.parent)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (#{p.id})
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Description</label>
              <Input
                value={newTagDescription}
                onChange={(e) => setNewTagDescription(e.target.value)}
                placeholder="Brief description of scope & responsibility"
                size="sm"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Verification Command</label>
              <Input
                value={newTagVerifyCmd}
                onChange={(e) => setNewTagVerifyCmd(e.target.value)}
                placeholder="e.g. npm test -- orders"
                size="sm"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-semibold text-foreground">Microservice Binding (optional)</label>
                <Input
                  value={newTagMicroserviceName}
                  onChange={(e) => setNewTagMicroserviceName(e.target.value)}
                  placeholder="e.g. orders-service"
                  size="sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Target Mode</label>
                <select
                  value={newTagMicroserviceTarget}
                  onChange={(e) => setNewTagMicroserviceTarget(e.target.value as 'edit' | 'reference')}
                  className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                >
                  <option value="edit">Edit (Worktree)</option>
                  <option value="reference">Reference Only</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Architectural Invariants & Rules (one per line)</label>
              <textarea
                rows={3}
                value={newTagRules}
                onChange={(e) => setNewTagRules(e.target.value)}
                placeholder="e.g. Order amounts must always include currency code and tax breakdown."
                className="w-full text-xs font-mono p-2 rounded-md border border-border bg-background text-foreground resize-y"
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreateTagModal(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={!newTagId.trim() || !newTagName.trim() || savingNewTag}
              onClick={() => void handleCreateDomainPack()}
            >
              {savingNewTag ? <Spinner size="sm" /> : <Check size={12} />}
              <span>Create Category</span>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* MODAL: INSPECT & EDIT EXISTING CATEGORY / TRAIT TAG */}
      <Dialog open={!!inspectingTag} onOpenChange={(open) => !open && setInspectingTag(null)}>
        <DialogPopup className="max-w-xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between pr-6">
              <DialogTitle className="flex items-center gap-2">
                {inspectTagType === 'trait' ? (
                  <ShieldCheck size={18} className="text-indigo-400" />
                ) : (
                  <Tag size={18} className="text-primary" />
                )}
                <span>Inspect & Edit {inspectTagType === 'trait' ? 'Trait' : 'Category'}</span>
              </DialogTitle>
              {inspectingTag && (
                <span
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold border',
                    inspectingTag.isTemplate
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-warning-foreground',
                  )}
                >
                  {inspectingTag.isTemplate ? 'Built-in Template' : 'Custom / Overridden'}
                </span>
              )}
            </div>
            <DialogDescription>
              View and configure full details: architectural invariants, verification command, scoped microservices, and attached agent skills.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-4 py-2 overflow-y-auto flex-1 pr-1">
            {/* Name & ID Slug */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Name</label>
                <Input
                  value={inspectTagName}
                  onChange={(e) => setInspectTagName(e.target.value)}
                  placeholder="e.g. Order Processing"
                  size="sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Tag ID / Slug</label>
                <Input
                  value={inspectingTag?.id || ''}
                  disabled
                  size="sm"
                  className="bg-muted/50 font-mono text-xs cursor-not-allowed"
                />
              </div>
            </div>

            {/* Type & Parent */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Category Type</label>
                <select
                  value={inspectTagType}
                  onChange={(e) => setInspectTagType(e.target.value as 'vertical' | 'trait')}
                  className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                >
                  <option value="vertical">Vertical Subsystem</option>
                  <option value="trait">Horizontal Trait</option>
                </select>
              </div>
              {inspectTagType === 'vertical' && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">Parent Category</label>
                  <select
                    value={inspectTagParent}
                    onChange={(e) => setInspectTagParent(e.target.value)}
                    className="w-full h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                  >
                    <option value="">None (Top-level vertical)</option>
                    {availableDomainPacks
                      .filter((p) => p.categoryType !== 'trait' && !p.parent && p.id !== inspectingTag?.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (#{p.id})
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Description</label>
              <Input
                value={inspectTagDescription}
                onChange={(e) => setInspectTagDescription(e.target.value)}
                placeholder="Brief description of scope & responsibility"
                size="sm"
              />
            </div>

            {/* Architectural Invariants & Rules */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground">Architectural Invariants & Rules</label>
                <span className="text-[10px] text-muted-foreground">Injected into workspace AGENTS.md</span>
              </div>
              <textarea
                rows={4}
                value={inspectTagRules}
                onChange={(e) => setInspectTagRules(e.target.value)}
                placeholder="e.g. Orders must be signed before publishing to event bus.&#10;Amounts must include ISO-4217 currency code."
                className="w-full text-xs font-mono p-2 rounded-md border border-border bg-background text-foreground resize-y leading-relaxed"
              />
            </div>

            {/* Verification Command */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground">Mechanical Verification Command</label>
                <span className="text-[10px] text-muted-foreground">Runs during verification gates</span>
              </div>
              <Input
                value={inspectTagVerifyCmd}
                onChange={(e) => setInspectTagVerifyCmd(e.target.value)}
                placeholder="e.g. npm test -- orders"
                size="sm"
                className="font-mono text-xs"
              />
            </div>

            {/* Scoped Microservices */}
            <div className="space-y-2 p-3 rounded-lg bg-muted/20 border border-border/60">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <FolderGit2 size={13} className="text-primary" />
                  <span>Scoped Microservices ({inspectTagMicroservices.length})</span>
                </label>
                <span className="text-[10px] text-muted-foreground">Worktrees created when tag attached</span>
              </div>

              {inspectTagMicroservices.length > 0 && (
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                  {inspectTagMicroservices.map((ms, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between px-2 py-1 rounded bg-card border border-border/60 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium text-foreground">{ms.name}</span>
                        <span
                          className={cn(
                            'text-[9px] px-1.5 py-0.2 rounded font-semibold',
                            ms.target === 'edit'
                              ? 'bg-primary/15 text-primary border border-primary/20'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {ms.target === 'edit' ? 'Edit (Worktree)' : 'Reference'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setInspectTagMicroservices((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                        title="Remove microservice binding"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={inspectNewMsName}
                  onChange={(e) => setInspectNewMsName(e.target.value)}
                  placeholder="Microservice repo name (e.g. orders-service)"
                  size="sm"
                  className="flex-1 text-xs font-mono"
                />
                <select
                  value={inspectNewMsTarget}
                  onChange={(e) => setInspectNewMsTarget(e.target.value as 'edit' | 'reference')}
                  className="h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                >
                  <option value="edit">Edit (Worktree)</option>
                  <option value="reference">Reference Only</option>
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={!inspectNewMsName.trim()}
                  onClick={() => {
                    if (!inspectNewMsName.trim()) return;
                    setInspectTagMicroservices((prev) => [
                      ...prev,
                      { name: inspectNewMsName.trim(), target: inspectNewMsTarget },
                    ]);
                    setInspectNewMsName('');
                  }}
                  className="h-7.5 text-xs shrink-0"
                >
                  <Plus size={11} className="mr-1" />
                  Add
                </Button>
              </div>
            </div>

            {/* Attached Skills */}
            <div className="space-y-2 p-3 rounded-lg bg-muted/20 border border-border/60">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles size={13} className="text-primary" />
                  <span>Attached Skills ({inspectTagSkills.length})</span>
                </label>
                <span className="text-[10px] text-muted-foreground">Auto-activated when tag is selected</span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 min-h-7">
                {inspectTagSkills.length === 0 ? (
                  <span className="text-xs text-muted-foreground italic">No attached skills.</span>
                ) : (
                  inspectTagSkills.map((skId) => {
                    const skillObj = allSkills.find((s) => s.id === skId);
                    return (
                      <span
                        key={skId}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-primary/10 text-primary border border-primary/20 font-medium"
                      >
                        <span>{skillObj?.title || skillObj?.name || skId}</span>
                        <button
                          type="button"
                          onClick={() => setInspectTagSkills((prev) => prev.filter((id) => id !== skId))}
                          className="hover:text-destructive cursor-pointer ml-0.5"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <select
                  value={inspectNewSkill}
                  onChange={(e) => setInspectNewSkill(e.target.value)}
                  className="flex-1 h-7.5 px-2 text-xs rounded-md border border-border bg-background text-foreground"
                >
                  <option value="">Select a skill to attach...</option>
                  {allSkills
                    .filter((s) => !inspectTagSkills.includes(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title || s.name} ({s.id})
                      </option>
                    ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={!inspectNewSkill}
                  onClick={() => {
                    if (!inspectNewSkill) return;
                    setInspectTagSkills((prev) => [...prev, inspectNewSkill]);
                    setInspectNewSkill('');
                  }}
                  className="h-7.5 text-xs shrink-0"
                >
                  <Plus size={11} className="mr-1" />
                  Attach Skill
                </Button>
              </div>
            </div>

            {/* Tags / Keywords */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Discovery Tags (comma-separated)</label>
              <Input
                value={inspectTagTags}
                onChange={(e) => setInspectTagTags(e.target.value)}
                placeholder="e.g. economy, finance, invoicing"
                size="sm"
                className="font-mono text-xs"
              />
            </div>
          </DialogPanel>

          <DialogFooter className="flex items-center justify-between sm:justify-between w-full pt-3 border-t">
            <div>
              {Boolean(inspectingTag && (!inspectingTag.builtin || !inspectingTag.isTemplate)) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDeleteOrResetTag()}
                  disabled={deletingTagDetails || savingTagDetails}
                  className="text-destructive hover:bg-destructive/10 border-destructive/30 text-xs gap-1.5"
                >
                  {deletingTagDetails ? (
                    <Spinner size="sm" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                  <span>
                    {inspectingTag?.builtin ? 'Reset to Defaults' : 'Delete Tag'}
                  </span>
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setInspectingTag(null)}>
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!inspectTagName.trim() || savingTagDetails}
                onClick={() => void handleSaveTagDetails()}
                className="gap-1.5"
              >
                {savingTagDetails ? <Spinner size="sm" /> : <Check size={12} />}
                <span>Save Changes</span>
              </Button>
            </div>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
