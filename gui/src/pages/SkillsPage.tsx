import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  Plus,
  Edit2,
  Trash2,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Check,
  Code2,
  FolderGit2,
  Wrench,
  Search,
  Sparkles,
  GitPullRequest,
  FlaskConical,
  Package,
  Database,
  ShieldCheck,
  Terminal,
  Zap,
  Cpu,
  Layers,
  X,
  ArrowRightLeft,
  Eye,
  FileText,
  CheckSquare,
  Square,
} from 'lucide-react';

import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ScrollArea } from '../components/ui/scroll-area.js';
import { Spinner } from '../components/ui/spinner.js';
import { Textarea } from '../components/ui/textarea.js';
import { cn } from '../lib/utils.js';
import { toErrorMessage } from '../lib/errors.js';
import {
  useSkillCategories,
  useSaveSkillCategory,
  useDeleteSkillCategory,
  useSkills,
  useSkillDiagnostics,
  useSaveSkill,
  useDeleteSkill,
  useWorkspaceSkills,
  useAssignWorkspaceSkills,
  useWorkspaces,
  useDomainPacks,
} from '../lib/api/queries.js';
import { SkillDiagnosticsPanel } from '../features/skills/SkillDiagnosticsPanel.js';
import { SkillsExplorer } from '../features/skills/SkillsExplorer.js';
import {
  canDeleteSkill, deleteWorkspaceFor, groupToggled, matchesSkillSearch, scopeLabel, selectionFor, selectionState, skillTargets, toggled,
  type SelectionDraft,
} from '../features/skills/skillSelection.js';
import type { SkillCategory, SkillItem } from '../types.js';

// Available icons
const ICON_MAP: Record<string, React.ElementType> = {
  'git-pull-request': GitPullRequest,
  'flask-conical': FlaskConical,
  package: Package,
  database: Database,
  'shield-check': ShieldCheck,
  terminal: Terminal,
  zap: Zap,
  cpu: Cpu,
  layers: Layers,
  boxes: Boxes,
  code: Code2,
};

// Available color presets
const COLOR_PRESETS = [
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#10b981' },
  { label: 'Purple', value: '#8b5cf6' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Emerald', value: '#059669' },
];

export interface SkillsPageProps {
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
}


export function SkillsPage({ showToast }: SkillsPageProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('global');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  // Category Modal State
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Partial<SkillCategory> | null>(null);

  // Skill Editor Modal State
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Partial<SkillItem> | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [skillModalTab, setSkillModalTab] = useState<'edit' | 'preview'>('edit');
  const [editingSkillScope, setEditingSkillScope] = useState<'global' | 'workspace'>('global');
  const [editingSkillWorkspaceId, setEditingSkillWorkspaceId] = useState<string>('');

  // Move-To Menu Modal State
  const [moveSkillModalOpen, setMoveSkillModalOpen] = useState(false);
  const [skillToMove, setSkillToMove] = useState<SkillItem | null>(null);

  // Delete Confirmation Modal State
  const [deleteConfirmModalOpen, setDeleteConfirmModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'category' | 'skill'; id: string; title: string; workspaceId?: string } | null>(null);

  // Drag and Drop state
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);

  // Queries & Mutations
  const { data: categories = [], isLoading: loadingCategories } = useSkillCategories();
  const { data: skills = [], isLoading: loadingSkills } = useSkills(
    selectedWorkspace !== 'global' ? selectedWorkspace : undefined,
  );
  const { data: skillDiagnostics = [] } = useSkillDiagnostics(
    selectedWorkspace !== 'global' ? selectedWorkspace : undefined,
  );
  const { data: workspaces = [] } = useWorkspaces();
  const { data: domainPacks = [] } = useDomainPacks();
  const {
    data: workspaceSkillsConfig,
    isLoading: loadingWorkspaceConfig,
    isError: workspaceConfigError,
  } = useWorkspaceSkills(
    selectedWorkspace !== 'global' ? selectedWorkspace : '',
  );
  // Enable/disable choices not yet saved, kept per workspace with the revision they started from.
  const [drafts, setDrafts] = useState<Record<string, SelectionDraft>>({});

  // Distinct domain and keyword tags available for skills assignment
  const availableSkillTags = Array.from(
    new Set(
      domainPacks
        .flatMap((p) => [p.id, ...(p.tags || [])])
        .concat(['git', 'pr', 'testing', 'security', 'performance', 'database', 'ci-cd', 'frontend', 'backend'])
        .filter(Boolean),
    ),
  ).slice(0, 24);

  const saveCategoryMutation = useSaveSkillCategory();
  const deleteCategoryMutation = useDeleteSkillCategory();
  const saveSkillMutation = useSaveSkill();
  const deleteSkillMutation = useDeleteSkill();
  const assignSkillsMutation = useAssignWorkspaceSkills();

  const isWorkspaceView = selectedWorkspace !== 'global';
  const scopedWorkspace = isWorkspaceView ? workspaces.find((candidate) => candidate.id === selectedWorkspace) : undefined;
  // The choice on screen is this workspace's unsaved one, else what is saved. A refetch never replaces an unsaved
  // choice, and another workspace's choice never shows here.
  const draft = isWorkspaceView ? drafts[selectedWorkspace] : undefined;
  const draftEnabledSkills = isWorkspaceView ? selectionFor(draft, workspaceSkillsConfig) : null;
  const selectionStatus = isWorkspaceView ? selectionState(draft, workspaceSkillsConfig) : 'saved';
  const enabledSkillIds = new Set(draftEnabledSkills ?? []);
  const workspaceAssignmentReady =
    !isWorkspaceView || (!loadingWorkspaceConfig && !workspaceConfigError && !!workspaceSkillsConfig);
  const discardDraft = () => setDrafts((previous) => {
    const next = { ...previous };
    delete next[selectedWorkspace];
    return next;
  });

  const toggleCategoryCollapse = (catId: string) => {
    setCollapsedCategories((prev) => ({ ...prev, [catId]: !prev[catId] }));
  };

  // ─── Filtered Skills by Category ──────────────────────────────────────────

  const filteredSkills = skills.filter((s) => matchesSkillSearch(s, searchQuery));

  const skillsByCategory = categories.reduce<Record<string, SkillItem[]>>((acc, cat) => {
    acc[cat.id] = filteredSkills.filter((s) => s.category === cat.id);
    return acc;
  }, {});

  // Any skills without category
  const uncategorizedSkills = filteredSkills.filter(
    (s) => !s.category || !categories.some((c) => c.id === s.category),
  );

  // ─── Category CRUD ────────────────────────────────────────────────────────

  const handleOpenCategoryModal = (cat?: SkillCategory) => {
    setEditingCategory(
      cat || {
        name: '',
        description: '',
        icon: 'boxes',
        color: '#3b82f6',
        custom: true,
      },
    );
    setCategoryModalOpen(true);
  };

  const handleSaveCategory = async () => {
    if (!editingCategory || !editingCategory.name?.trim()) return;
    try {
      await saveCategoryMutation.mutateAsync({
        id: editingCategory.id,
        name: editingCategory.name.trim(),
        description: editingCategory.description,
        icon: editingCategory.icon,
        color: editingCategory.color,
      });
      showToast?.('Category saved successfully', 'success');
      setCategoryModalOpen(false);
      setEditingCategory(null);
    } catch (err) {
      showToast?.('Failed to save category', 'error');
      console.error(err);
    }
  };

  const confirmDeleteCategory = (cat: SkillCategory, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ type: 'category', id: cat.id, title: cat.name });
    setDeleteConfirmModalOpen(true);
  };

  // ─── Skill CRUD ───────────────────────────────────────────────────────────

  const handleOpenSkillModal = (skill?: SkillItem, defaultCatId?: string) => {
    const defaultScope = skill?.scope ?? (isWorkspaceView ? 'workspace' : 'global');
    setEditingSkillScope(defaultScope);
    setEditingSkillWorkspaceId(
      isWorkspaceView ? selectedWorkspace : (skillTargets(workspaces)[0]?.id || ''),
    );
    setEditingSkill(
      skill || {
        name: '',
        title: '',
        category: defaultCatId || (categories[0]?.id ?? 'pull-requests'),
        description: '',
        tags: [],
        allowedTools: [],
        content: '# Skill Title\n\nInstructions and playbook for the AI assistant.\n',
        custom: true,
        scope: defaultScope,
      },
    );
    setSlugManuallyEdited(!!skill);
    setSkillModalTab('edit');
    setSkillModalOpen(true);
  };

  useEffect(() => {
    const targets = skillTargets(workspaces);
    if (!editingSkillWorkspaceId && targets.length > 0) {
      setEditingSkillWorkspaceId(targets[0].id);
    }
  }, [workspaces, editingSkillWorkspaceId]);

  const handleTitleChange = (newTitle: string) => {
    if (!editingSkill) return;
    const next: Partial<SkillItem> = { ...editingSkill, title: newTitle };
    if (!slugManuallyEdited && !editingSkill.id) {
      next.name = newTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
    setEditingSkill(next);
  };

  const handleSaveSkill = async () => {
    if (
      !editingSkill ||
      !editingSkill.name?.trim() ||
      !editingSkill.description?.trim() ||
      !editingSkill.content?.trim()
    ) {
      showToast?.('Skill name, trigger description, and content are required', 'error');
      return;
    }
    if (editingSkillScope === 'workspace' && !editingSkillWorkspaceId) {
      showToast?.('Please select a target workspace for workspace-local skill', 'error');
      return;
    }
    try {
      await saveSkillMutation.mutateAsync({
        id: editingSkill.id,
        name: editingSkill.name.trim(),
        title: editingSkill.title || editingSkill.name,
        category: editingSkill.category || 'general',
        description: editingSkill.description || '',
        tags: editingSkill.tags || [],
        allowedTools: editingSkill.allowedTools || [],
        content: editingSkill.content,
        scope: editingSkillScope,
        workspaceId: editingSkillScope === 'workspace' ? editingSkillWorkspaceId : undefined,
      });
      showToast?.(
        editingSkillScope === 'workspace'
          ? 'Workspace skill saved successfully in .agents/skills/'
          : 'Global skill package saved successfully',
        'success',
      );
      setSkillModalOpen(false);
      setEditingSkill(null);
    } catch (err) {
      showToast?.(toErrorMessage(err, 'Failed to save skill'), 'error');
      console.error(err);
    }
  };

  const confirmDeleteSkill = (skill: SkillItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    // From the skill and the page being viewed, never from what the editor was last open on.
    setDeleteTarget({ type: 'skill', id: skill.id, title: skill.title || skill.name, workspaceId: deleteWorkspaceFor(skill, selectedWorkspace) });
    setDeleteConfirmModalOpen(true);
  };

  const handleExecuteDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'category') {
        await deleteCategoryMutation.mutateAsync(deleteTarget.id);
        showToast?.('Category deleted', 'info');
      } else {
        await deleteSkillMutation.mutateAsync({
          id: deleteTarget.id,
          workspaceId: deleteTarget.workspaceId,
        });
        showToast?.('Skill package deleted', 'info');
      }
      setDeleteConfirmModalOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      showToast?.(toErrorMessage(err, 'Failed to delete item'), 'error');
      console.error(err);
    }
  };

  // ─── Workspace Assignment Toggles ─────────────────────────────────────────

  const handleToggleWorkspaceSkill = (skillId: string) => {
    if (!isWorkspaceView || !workspaceAssignmentReady || !workspaceSkillsConfig) return;
    setDrafts((previous) => ({ ...previous, [selectedWorkspace]: toggled(previous[selectedWorkspace], workspaceSkillsConfig, skillId) }));
  };

  const handleCopyBuiltInSkill = () => {
    if (!editingSkill || editingSkill.custom !== false) return;
    const copyName = `${editingSkill.name}-copy`;
    setEditingSkill({
      ...editingSkill,
      id: undefined,
      name: copyName,
      title: `${editingSkill.title || editingSkill.name} Copy`,
      allowedTools: [],
      custom: true,
      sourcePath: undefined,
      references: undefined,
      scripts: undefined,
    });
    setSlugManuallyEdited(true);
  };

  const handleToggleCategoryAll = (catId: string, enable: boolean) => {
    if (!isWorkspaceView || !workspaceAssignmentReady || !workspaceSkillsConfig) return;
    const ids = (skillsByCategory[catId] || []).map((skill) => skill.id);
    setDrafts((previous) => ({ ...previous, [selectedWorkspace]: groupToggled(previous[selectedWorkspace], workspaceSkillsConfig, ids, enable) }));
  };

  const handleApplyWorkspaceSkills = async () => {
    if (!workspaceSkillsConfig || draftEnabledSkills === null || !isWorkspaceView) return;
    try {
      await assignSkillsMutation.mutateAsync({
        workspaceId: selectedWorkspace,
        // The revision the choice started from, so a selection saved meanwhile by someone else is refused, not replaced.
        expectedRevision: draft?.revision ?? workspaceSkillsConfig.revision ?? 0,
        enabledSkills: draftEnabledSkills,
        enabledAgents: workspaceSkillsConfig.enabledAgents ?? [],
        enabledCategories: categories.map((category) => category.id),
      });
      discardDraft();
      showToast?.('Skill selection saved. Refresh the workspace to apply it.', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to save skill selection', 'error');
    }
  };

  // ─── Drag & Drop and Move to Category ─────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, skillId: string) => {
    e.dataTransfer.setData('text/plain', skillId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingSkillId(skillId);
  };

  const handleDragOver = (e: React.DragEvent, catId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverCategoryId !== catId) {
      setDragOverCategoryId(catId);
    }
  };

  const handleDragLeave = () => {
    setDragOverCategoryId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetCatId: string) => {
    e.preventDefault();
    setDragOverCategoryId(null);
    const skillId = e.dataTransfer.getData('text/plain') || draggingSkillId;
    setDraggingSkillId(null);
    if (!skillId) return;

    const skill = skills.find((s) => s.id === skillId);
    if (!skill || !skill.custom || isWorkspaceView || skill.category === targetCatId) return;

    try {
      await saveSkillMutation.mutateAsync({
        id: skill.id,
        name: skill.name,
        title: skill.title,
        description: skill.description,
        tags: skill.tags,
        allowedTools: skill.allowedTools,
        content: skill.content,
        category: targetCatId,
      });
      showToast?.('Skill re-categorized', 'success');
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Failed to move the skill', 'error');
    }
  };

  const handleOpenMoveModal = (skill: SkillItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setSkillToMove(skill);
    setMoveSkillModalOpen(true);
  };

  const handleExecuteMoveSkill = async (targetCatId: string) => {
    if (!skillToMove || skillToMove.category === targetCatId) {
      setMoveSkillModalOpen(false);
      setSkillToMove(null);
      return;
    }
    try {
      await saveSkillMutation.mutateAsync({
        id: skillToMove.id,
        name: skillToMove.name,
        title: skillToMove.title,
        description: skillToMove.description,
        tags: skillToMove.tags,
        allowedTools: skillToMove.allowedTools,
        content: skillToMove.content,
        category: targetCatId,
      });
    } catch (err) {
      // The dialog stays open so the move can be tried again or another category chosen.
      showToast?.(err instanceof Error ? err.message : 'Failed to move the skill', 'error');
      return;
    }
    showToast?.('Skill moved to category', 'success');
    setMoveSkillModalOpen(false);
    setSkillToMove(null);
  };


  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background text-foreground">
      {/* Header Bar */}
      <div className="p-6 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-card/40 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Boxes className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Skill Library</h1>
              <p className="text-sm text-muted-foreground">
                Create, organize, and assign reusable Agent Skill packages.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button render={<Link to="/agents" />} variant="outline" size="sm">Codex Agents</Button>
          {/* Workspace Scoping Selector */}
          <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-1.5 border border-border">
            <FolderGit2 className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="skill-scope" className="text-xs font-medium text-muted-foreground">Scope:</Label>
            <select
              id="skill-scope"
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              className="bg-transparent text-xs font-semibold cursor-pointer text-foreground"
            >
              <option value="global" className="bg-popover text-popover-foreground">
                🌐 Global Skills Catalog
              </option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id} className="bg-popover text-popover-foreground">
                  📁 {scopeLabel(ws)}
                </option>
              ))}

            </select>
          </div>

          {!isWorkspaceView && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenCategoryModal()}
              className="flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Category</span>
            </Button>
          )}

          {isWorkspaceView && selectionStatus !== 'saved' && (
            <>
              <span role="status" className="text-xs text-muted-foreground">
                {selectionStatus === 'outdated'
                  ? 'This selection was changed elsewhere since you started. Discard your changes to start again.'
                  : 'Unsaved changes'}
              </span>
              <Button size="sm" variant="outline" onClick={discardDraft}>Discard</Button>
            </>
          )}
          {/* The workspace's own skills view (agents, deploy) has no place on the workspace rail: it opens from here. An
              archived workspace has no such view. */}
          {scopedWorkspace && !scopedWorkspace.archivedAt && (
            <Button render={<Link to={`/workspaces/${encodeURIComponent(scopedWorkspace.branchName)}/skills`} />} variant="outline" size="sm">
              This workspace's skills
            </Button>
          )}
          {isWorkspaceView && (
            <Button
              size="sm"
              onClick={handleApplyWorkspaceSkills}
              disabled={!workspaceAssignmentReady || assignSkillsMutation.isPending || draftEnabledSkills === null || selectionStatus === 'outdated'}
            >
              {assignSkillsMutation.isPending ? 'Saving…' : 'Save selection'}
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => handleOpenSkillModal()}
            className="flex items-center gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>New Skill</span>
          </Button>
        </div>
      </div>

      {skillDiagnostics.length > 0 && (
        <div className="px-6 pt-4">
          <SkillDiagnosticsPanel diagnostics={skillDiagnostics} />
        </div>
      )}

      {!isWorkspaceView && (
        <SkillsExplorer
          skills={skills}
          showToast={showToast}
          onEdit={(skill) => handleOpenSkillModal(skill)}
          onDelete={(skill) => confirmDeleteSkill(skill)}
          onMove={(skill, event) => handleOpenMoveModal(skill, event)}
        />
      )}

      {isWorkspaceView && (
        <>
        {/* Search and Filter Ribbon */}
        <div className="px-6 py-3 border-b border-border/60 bg-muted/20 flex items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills by keyword, tag, or tool..."
              className="pl-9 pr-8 h-9 text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Showing <strong className="text-foreground">{filteredSkills.length}</strong> of{' '}
              <strong className="text-foreground">{skills.length}</strong> skills
            </span>
            {isWorkspaceView && (
              <Badge variant="secondary" className="text-[10px] uppercase font-mono">
                Workspace Mode ({enabledSkillIds.size} active)
              </Badge>
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <ScrollArea className="flex-1 p-6">
          {loadingCategories || loadingSkills || (isWorkspaceView && loadingWorkspaceConfig) ? (
            <div className="flex items-center justify-center p-12 gap-3 text-muted-foreground">
              <Spinner />
              <span className="text-sm">Loading skills catalog...</span>
            </div>
          ) : isWorkspaceView && workspaceConfigError ? (
            <Empty className="py-12 border border-dashed rounded-xl">
              <EmptyHeader>
                <EmptyTitle>Workspace resources could not be loaded</EmptyTitle>
                <EmptyDescription>Assignment controls are disabled so an existing selection cannot be overwritten.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : filteredSkills.length === 0 && searchQuery ? (
            <Empty className="py-12 border border-dashed rounded-xl">
              <EmptyMedia>
                <Search className="h-8 w-8 text-muted-foreground" />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No matching skills found</EmptyTitle>
                <EmptyDescription>
                  No skills matched your search query "{searchQuery}".
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" size="sm" onClick={() => setSearchQuery('')}>
                Clear Search
              </Button>
            </Empty>
          ) : (
            <div className="space-y-6 max-w-7xl mx-auto pb-12">
              {categories.map((category) => {
                const IconComp = ICON_MAP[category.icon || 'boxes'] || Boxes;
                const catSkills = skillsByCategory[category.id] || [];
                const isCollapsed = !!collapsedCategories[category.id];
                const isDragTarget = dragOverCategoryId === category.id;
                const allCatEnabled =
                  catSkills.length > 0 && catSkills.every((s) => enabledSkillIds.has(s.id));

                return (
                  <div
                    key={category.id}
                    onDragOver={(e) => handleDragOver(e, category.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, category.id)}
                    className={cn(
                      'border rounded-xl transition-all duration-150 overflow-hidden bg-card/60',
                      isDragTarget ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-border',
                    )}
                  >
                    {/* Category Box Header */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleCategoryCollapse(category.id)}
                      onKeyDown={(e) => {
                        // A key pressed on a button inside the header is that button's, not the header's.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleCategoryCollapse(category.id);
                        }
                      }}
                      className="p-4 flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors border-b border-border/40 select-none"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="p-2 rounded-lg text-white shadow-sm flex items-center justify-center"
                          style={{ backgroundColor: category.color || '#3b82f6' }}
                        >
                          <IconComp className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h2 className="font-semibold text-sm tracking-tight">{category.name}</h2>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {catSkills.length} {catSkills.length === 1 ? 'skill' : 'skills'}
                            </Badge>
                            {category.isTemplate && !category.custom && (
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 uppercase">
                                Template
                              </Badge>
                            )}
                          </div>
                          {category.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">{category.description}</p>
                          )}
                        </div>
                      </div>

                      {/* Category Box Actions */}
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {isWorkspaceView && catSkills.length > 0 && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => handleToggleCategoryAll(category.id, !allCatEnabled)}
                            className="h-7 text-xs mr-2 text-muted-foreground hover:text-foreground"
                            title={allCatEnabled ? 'Deselect all in category' : 'Select all in category'}
                          >
                            {allCatEnabled ? (
                              <CheckSquare className="h-3.5 w-3.5 mr-1 text-primary" />
                            ) : (
                              <Square className="h-3.5 w-3.5 mr-1" />
                            )}
                            <span>{allCatEnabled ? 'Deselect All' : 'Select All'}</span>
                          </Button>
                        )}

                        {!isWorkspaceView && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleOpenSkillModal(undefined, category.id)}
                            title="Add skill to this category"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        )}

                        {!isWorkspaceView && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleOpenCategoryModal(category)}
                            title="Edit category"
                          >
                            <Edit2 className="h-3 w-3" />
                          </Button>
                        )}

                        {!isWorkspaceView && category.custom && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => confirmDeleteCategory(category, e)}
                            title="Delete category"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}

                        <div className="p-1 text-muted-foreground">
                          {isCollapsed ? (
                            <ChevronRight className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Skills Grid */}
                    {!isCollapsed && (
                      <div className="p-4 bg-background/50">
                        {catSkills.length === 0 ? (
                          <div className="border border-dashed border-border/80 rounded-lg p-6 text-center text-xs text-muted-foreground">
                             {searchQuery.trim() ? 'No skills in this category match your search.' : 'No skills in this category.'}
                             {!isWorkspaceView && !searchQuery.trim() && (
                               <>{' '}Drag a custom skill here, or click{' '}
                                 <button
                                   onClick={() => handleOpenSkillModal(undefined, category.id)}
                                   className="text-primary underline font-medium"
                                 >
                                   + Add Skill
                                 </button>
                               </>
                             )}
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                            {catSkills.map((skill) => {
                              const isEnabledInWs = enabledSkillIds.has(skill.id);
                              return (
                                <Card
                                  key={skill.id}
                                  draggable={!isWorkspaceView && !!skill.custom}
                                  onDragStart={(e) => {
                                    if (!isWorkspaceView && skill.custom) handleDragStart(e, skill.id);
                                  }}
                                  onClick={() => handleOpenSkillModal(skill)}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(event) => {
                                    // A key pressed on a button inside the card is that button's, not the card's.
                                    if (event.target !== event.currentTarget) return;
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      handleOpenSkillModal(skill);
                                    }
                                  }}
                                  className={cn(
                                    'group relative cursor-pointer hover:border-primary/60 transition-all p-3.5 flex flex-col justify-between select-none shadow-sm',
                                    isWorkspaceView && !isEnabledInWs && 'opacity-60 bg-muted/20',
                                    draggingSkillId === skill.id && 'opacity-40 border-dashed',
                                  )}
                                >
                                  <div>
                                    {/* Card Top: Drag Handle & Workspace Toggle */}
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                      <div
                                        className="flex items-center gap-1.5 text-muted-foreground group-hover:text-foreground cursor-grab active:cursor-grabbing"
                                        title="Drag to reorder or re-categorize"
                                        aria-label="Drag handle"
                                      >
                                        <GripVertical className="h-3.5 w-3.5" />
                                        <span className="font-mono text-xs font-bold text-foreground">
                                          {skill.title || skill.name}
                                        </span>
                                      </div>

                                      {/* Workspace Active Checkbox & Badges */}
                                      {isWorkspaceView ? (
                                        <div className="flex items-center gap-1">
                                          <Badge
                                            variant="outline"
                                            className={cn(
                                              'text-[9px] font-mono px-1 py-0.2 uppercase',
                                              skill.scope === 'workspace'
                                                ? 'border-amber-500/40 text-warning-foreground bg-amber-500/10'
                                                : 'border-blue-500/40 text-blue-300 bg-blue-500/10',
                                            )}
                                          >
                                            {skill.scope === 'workspace' ? 'Workspace' : 'Global'}
                                          </Badge>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleToggleWorkspaceSkill(skill.id);
                                            }}
                                            disabled={!workspaceAssignmentReady || assignSkillsMutation.isPending}
                                            className={cn(
                                              'h-5 px-2 rounded-md flex items-center gap-1 text-[10px] font-semibold transition-colors',
                                              isEnabledInWs
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                          >
                                            <Check className={cn('h-3 w-3', !isEnabledInWs && 'opacity-0')} />
                                            <span>{isEnabledInWs ? 'Enabled' : 'Disabled'}</span>
                                          </button>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-1">
                                          <Badge
                                            variant="outline"
                                            className={cn(
                                              'text-[9px] font-mono px-1 py-0.2 uppercase',
                                              skill.scope === 'workspace'
                                                ? 'border-amber-500/40 text-warning-foreground bg-amber-500/10'
                                                : 'border-blue-500/40 text-blue-300 bg-blue-500/10',
                                            )}
                                          >
                                            {skill.scope === 'workspace' ? 'Workspace' : 'Global'}
                                          </Badge>
                                          <Badge variant="outline" className="text-[10px] font-mono">
                                            {skill.custom ? 'Custom' : 'Template'}
                                          </Badge>
                                        </div>
                                      )}
                                    </div>

                                    {/* Description */}
                                    <p className="text-xs text-muted-foreground line-clamp-2 mb-3 leading-relaxed">
                                      {skill.description || 'No description provided.'}
                                    </p>
                                  </div>

                                  {/* Card Bottom: Tags & Quick Menu */}
                                  <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 flex-wrap overflow-hidden">
                                      {skill.tags?.slice(0, 3).map((tag) => (
                                        <span
                                          key={tag}
                                          className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground"
                                        >
                                          #{tag}
                                        </span>
                                      ))}
                                      {skill.allowedTools && skill.allowedTools.length > 0 && (
                                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 font-mono">
                                          <Wrench className="h-2.5 w-2.5" />
                                          {skill.allowedTools.length}
                                        </span>
                                      )}
                                    </div>

                                    {/* Card Quick Actions */}
                                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                      {!isWorkspaceView && skill.custom && (
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          onClick={(e) => handleOpenMoveModal(skill, e)}
                                          title="Move to another category"
                                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                        >
                                          <ArrowRightLeft className="h-3 w-3" />
                                        </Button>
                                      )}

                                      {canDeleteSkill(skill, isWorkspaceView) && (
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          onClick={(e) => confirmDeleteSkill(skill, e)}
                                          title="Delete skill"
                                          className="h-6 w-6 text-destructive hover:text-destructive cursor-pointer"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                </Card>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Uncategorized Skills Section */}
              {uncategorizedSkills.length > 0 && (
                <div className="border border-border/80 rounded-xl overflow-hidden bg-card/60">
                  <div className="p-4 bg-muted/30 border-b border-border/40 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Boxes className="h-4 w-4 text-muted-foreground" />
                      <h2 className="font-semibold text-sm">Uncategorized Skills</h2>
                      <Badge variant="outline" className="text-[10px]">
                        {uncategorizedSkills.length}
                      </Badge>
                    </div>
                  </div>
                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {uncategorizedSkills.map((skill) => (
                      <Card
                        key={skill.id}
                        onClick={() => handleOpenSkillModal(skill)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          // A key pressed on a button inside the card is that button's, not the card's.
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleOpenSkillModal(skill);
                          }
                        }}
                        className="p-3.5 cursor-pointer hover:border-primary/60 flex flex-col justify-between"
                      >
                        <div>
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="font-mono text-xs font-bold">{skill.title || skill.name}</div>
                            <div className="flex items-center gap-1">
                              <Badge
                                variant="outline"
                                className={cn(
                                  'text-[9px] font-mono px-1 py-0.2 uppercase',
                                  skill.scope === 'workspace'
                                    ? 'border-amber-500/40 text-warning-foreground bg-amber-500/10'
                                    : 'border-blue-500/40 text-blue-300 bg-blue-500/10',
                                )}
                              >
                                {skill.scope === 'workspace' ? 'Workspace' : 'Global'}
                              </Badge>
                              {isWorkspaceView && (
                                <Button
                                  size="xs"
                                  variant={enabledSkillIds.has(skill.id) ? 'default' : 'outline'}
                                  disabled={!workspaceAssignmentReady || assignSkillsMutation.isPending}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleToggleWorkspaceSkill(skill.id);
                                  }}
                                >
                                  {enabledSkillIds.has(skill.id) ? 'Enabled' : 'Disabled'}
                                </Button>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
                        </div>
                        {/* Card Bottom: Tags & Quick Menu */}
                        <div className="pt-2 mt-2 border-t border-border/40 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap overflow-hidden">
                            {skill.tags && skill.tags.length > 0 ? (
                              skill.tags.slice(0, 3).map((tag) => (
                                <span key={tag} className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                                  #{tag}
                                </span>
                              ))
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">No tags</span>
                            )}
                            {skill.allowedTools && skill.allowedTools.length > 0 && (
                              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 font-mono">
                                <Wrench className="h-2.5 w-2.5" />
                                {skill.allowedTools.length}
                              </span>
                            )}
                          </div>

                          {skill.custom && (
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              {!isWorkspaceView && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={(e) => handleOpenMoveModal(skill, e)}
                                  title="Move to a category"
                                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                >
                                  <ArrowRightLeft className="h-3 w-3" />
                                </Button>
                              )}
                              {canDeleteSkill(skill, isWorkspaceView) && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={(e) => confirmDeleteSkill(skill, e)}
                                  title="Delete skill"
                                  className="h-6 w-6 text-destructive hover:text-destructive cursor-pointer"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
        </>
      )}

      {/* ─── Category Create/Edit Modal ────────────────────────────────────── */}
      <Dialog open={categoryModalOpen} onOpenChange={setCategoryModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingCategory?.id ? 'Edit Skill Category' : 'Create Skill Category'}
            </DialogTitle>
            <DialogDescription>
              Categories group related procedural skills and agent tools into clean visual boxes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="cat-name" className="text-xs font-medium">
                Category Name
              </Label>
              <Input
                id="cat-name"
                value={editingCategory?.name || ''}
                onChange={(e) =>
                  setEditingCategory((prev) => (prev ? { ...prev, name: e.target.value } : null))
                }
                placeholder="e.g. Pull Requests & Review"
                className="mt-1 text-xs"
              />
            </div>

            <div>
              <Label htmlFor="cat-desc" className="text-xs font-medium">
                Description
              </Label>
              <Input
                id="cat-desc"
                value={editingCategory?.description || ''}
                onChange={(e) =>
                  setEditingCategory((prev) => (prev ? { ...prev, description: e.target.value } : null))
                }
                placeholder="Brief summary of what skills belong in this box..."
                className="mt-1 text-xs"
              />
            </div>

            {/* Icon Picker */}
            <div>
              <Label className="text-xs font-medium">Icon</Label>
              <div className="grid grid-cols-6 gap-2 mt-1.5">
                {Object.keys(ICON_MAP).map((iconKey) => {
                  const Icon = ICON_MAP[iconKey];
                  const isSelected = (editingCategory?.icon || 'boxes') === iconKey;
                  return (
                    <button
                      key={iconKey}
                      type="button"
                      onClick={() =>
                        setEditingCategory((prev) => (prev ? { ...prev, icon: iconKey } : null))
                      }
                      className={cn(
                        'p-2.5 rounded-lg border flex items-center justify-center transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Color Swatch Picker */}
            <div>
              <Label className="text-xs font-medium">Color Accent</Label>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {COLOR_PRESETS.map((c) => {
                  const isSelected = editingCategory?.color === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      aria-label={`Select color ${c.label}`}
                      onClick={() =>
                        setEditingCategory((prev) => (prev ? { ...prev, color: c.value } : null))
                      }
                      className={cn(
                        'w-7 h-7 rounded-full transition-transform flex items-center justify-center shadow-sm',
                        isSelected ? 'scale-110 ring-2 ring-primary ring-offset-2' : 'hover:scale-105',
                      )}
                      style={{ backgroundColor: c.value }}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5 text-white" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCategoryModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSaveCategory}
              disabled={!editingCategory?.name?.trim()}
            >
              Save Category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Skill Playbook Editor Modal ───────────────────────────────────── */}
      <Dialog open={skillModalOpen} onOpenChange={setSkillModalOpen}>
        <DialogContent className="max-w-[96vw] sm:max-w-5xl lg:max-w-6xl xl:max-w-7xl h-[90vh] max-h-[92vh] flex flex-col p-6">
          <DialogHeader className="pb-3 border-b border-border/70 shrink-0">
            <div className="flex items-center justify-between pr-8">
              <div>
                <DialogTitle className="text-base font-bold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span>{editingSkill?.id ? 'Edit Skill Package' : 'Create New Skill'}</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Configure SKILL.md metadata triggers and markdown playbook instructions.
                </DialogDescription>
              </div>
              <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-lg border border-border text-xs">
                <button
                  type="button"
                  onClick={() => setSkillModalTab('edit')}
                  className={cn(
                    'px-3 py-1.5 rounded-md flex items-center gap-1.5 font-medium transition-colors cursor-pointer',
                    skillModalTab === 'edit'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Edit</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSkillModalTab('preview')}
                  className={cn(
                    'px-3 py-1.5 rounded-md flex items-center gap-1.5 font-medium transition-colors cursor-pointer',
                    skillModalTab === 'preview'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span>Preview</span>
                </button>
              </div>
            </div>
          </DialogHeader>

          {/* Modal Main Body - 2-Column Responsive Layout */}
          <div className="flex-1 min-h-0 py-4 flex flex-col lg:flex-row gap-6 overflow-hidden">
            {/* Left Column: Metadata & Scopes */}
            <div className="lg:w-[420px] xl:w-[460px] shrink-0 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
              <div className="space-y-3">
                <div>
                  <Label htmlFor="skill-title" className="text-xs font-medium">
                    Display Title
                  </Label>
                  <Input
                    id="skill-title"
                    value={editingSkill?.title || ''}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    placeholder="e.g. Pull Request Reviewer"
                    className="mt-1 text-xs"
                  />
                </div>

                <div>
                  <Label htmlFor="skill-name" className="text-xs font-medium">
                    Identifier (Slug)
                  </Label>
                  <Input
                    id="skill-name"
                    value={editingSkill?.name || ''}
                    disabled={!!editingSkill?.id}
                    onChange={(e) => {
                      setSlugManuallyEdited(true);
                      setEditingSkill((prev) => (prev ? { ...prev, name: e.target.value } : null));
                    }}
                    placeholder="e.g. pr-review-toolkit"
                    className="mt-1 text-xs font-mono"
                  />
                </div>
              </div>

              {/* Scope Selector: Global vs Workspace-Local */}
              <div className="p-3 rounded-lg border border-border/80 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Boxes className="h-3.5 w-3.5 text-primary" />
                    <span>Skill Scope</span>
                  </Label>
                  <span className="text-[10px] text-muted-foreground">
                    {editingSkillScope === 'global' ? 'Machine-wide catalog' : 'Project-specific (.agents/skills/)'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingSkillScope('global')}
                    className={cn(
                      'flex items-center justify-center gap-2 p-2 rounded-lg border text-xs font-medium transition-all cursor-pointer',
                      editingSkillScope === 'global'
                        ? 'border-blue-500/50 bg-blue-500/15 text-blue-300 font-semibold shadow-xs'
                        : 'border-border/60 bg-card/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span>🌐 Global Catalog</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingSkillScope('workspace')}
                    className={cn(
                      'flex items-center justify-center gap-2 p-2 rounded-lg border text-xs font-medium transition-all cursor-pointer',
                      editingSkillScope === 'workspace'
                        ? 'border-amber-500/50 bg-amber-500/15 text-warning-foreground font-semibold shadow-xs'
                        : 'border-border/60 bg-card/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span>📁 Workspace-Local</span>
                  </button>
                </div>

                {editingSkillScope === 'workspace' && (
                  <div className="pt-1">
                    <Label htmlFor="target-ws" className="text-[11px] font-medium text-muted-foreground">
                      Target Workspace:
                    </Label>
                    {skillTargets(workspaces).length > 0 ? (
                      <select
                        id="target-ws"
                        value={editingSkillWorkspaceId}
                        onChange={(e) => setEditingSkillWorkspaceId(e.target.value)}
                        className="mt-1 w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      >
                        {skillTargets(workspaces).map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            📁 {scopeLabel(ws)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="mt-1 text-xs text-destructive italic">
                        No active workspaces found. Please create a workspace first.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Category & Tags */}
              <div className="space-y-3">
                <div>
                  <Label htmlFor="skill-cat" className="text-xs font-medium">
                    Category Box
                  </Label>
                  <select
                    id="skill-cat"
                    value={editingSkill?.category || ''}
                    onChange={(e) =>
                      setEditingSkill((prev) => (prev ? { ...prev, category: e.target.value } : null))
                    }
                    className="mt-1 w-full bg-background border border-border rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="skill-tags" className="text-xs font-medium">
                      Tags & Domain Categories
                    </Label>
                    <span className="text-[10px] text-muted-foreground">Click chips below to toggle</span>
                  </div>
                  <Input
                    id="skill-tags"
                    value={editingSkill?.tags?.join(', ') || ''}
                    onChange={(e) =>
                      setEditingSkill((prev) =>
                        prev
                          ? {
                              ...prev,
                              tags: e.target.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean),
                            }
                          : null,
                      )
                    }
                    placeholder="e.g. nexusflow, core, cli, testing"
                    className="mt-1 text-xs font-mono"
                  />
                </div>

                {/* Interactive Tag Chips */}
                {availableSkillTags.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Quick Tag Assignment:</span>
                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-1">
                      {availableSkillTags.map((tag) => {
                        const isAssigned = editingSkill?.tags?.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => {
                              setEditingSkill((prev) => {
                                if (!prev) return null;
                                const currentTags = prev.tags || [];
                                const nextTags = isAssigned
                                  ? currentTags.filter((t) => t !== tag)
                                  : [...currentTags, tag];
                                return { ...prev, tags: nextTags };
                              });
                            }}
                            className={cn(
                              'px-2 py-0.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer border',
                              isAssigned
                                ? 'bg-primary/20 text-primary border-primary/40 font-semibold shadow-xs'
                                : 'bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted hover:text-foreground',
                            )}
                          >
                            #{tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Trigger Description */}
              <div>
                <Label htmlFor="skill-desc" className="text-xs font-medium">
                  Trigger Description (for AI Autonomous Discovery)
                </Label>
                <Textarea
                  id="skill-desc"
                  rows={3}
                  value={editingSkill?.description || ''}
                  onChange={(e) =>
                    setEditingSkill((prev) => (prev ? { ...prev, description: e.target.value } : null))
                  }
                  placeholder="e.g. Use when reviewing PR diffs or when user asks for a PR audit..."
                  className="mt-1 text-xs leading-relaxed resize-none"
                />
              </div>
            </div>

            {/* Right Column: Playbook Editor or Preview */}
            <div className="flex-1 min-w-0 flex flex-col min-h-[380px] lg:min-h-0 border-t lg:border-t-0 lg:border-l border-border/70 pt-4 lg:pt-0 lg:pl-6">
              {skillModalTab === 'edit' ? (
                <div className="flex flex-col flex-1 min-h-0 h-full">
                  <div className="flex items-center justify-between pb-2 shrink-0">
                    <Label htmlFor="skill-content" className="text-xs font-semibold flex items-center gap-1.5">
                      <Code2 className="h-3.5 w-3.5 text-primary" />
                      <span>Playbook Instructions (Markdown)</span>
                    </Label>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {(editingSkill?.content || '').split('\n').length} lines · {(editingSkill?.content || '').length} characters
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
                    Frontmatter (<code className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded text-foreground">name</code>,{' '}
                    <code className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded text-foreground">description</code>,{' '}
                    <code className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded text-foreground">tags</code>) is managed in the Metadata panel on the left and auto-injected into{' '}
                    <code className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded text-foreground">SKILL.md</code> on save.
                  </p>
                  <Textarea
                    id="skill-content"
                    value={editingSkill?.content || ''}
                    onChange={(e) =>
                      setEditingSkill((prev) => (prev ? { ...prev, content: e.target.value } : null))
                    }
                    placeholder="# Playbook Title&#10;&#10;Detailed instructions for the AI assistant..."
                    className="flex-1 w-full min-h-[360px] lg:min-h-full font-mono text-xs leading-relaxed resize-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              ) : (
                <div className="flex flex-col flex-1 min-h-0 h-full">
                  <div className="flex items-center justify-between pb-2 shrink-0">
                    <span className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
                      <Eye className="h-3.5 w-3.5 text-primary" />
                      <span>Documentation Preview</span>
                    </span>
                    <Badge variant="outline" className="text-[10px] font-mono">
                      SKILL.md
                    </Badge>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5 border rounded-lg bg-card/40 prose prose-sm dark:prose-invert max-w-none">
                    <div className="mb-4 pb-3 border-b border-border/70">
                      <h2 className="text-lg font-bold m-0 text-foreground">{editingSkill?.title || editingSkill?.name}</h2>
                      <p className="text-xs text-muted-foreground m-0 mt-1">{editingSkill?.description}</p>
                      {editingSkill?.tags && editingSkill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2.5">
                          {editingSkill.tags.map((t) => (
                            <span key={t} className="px-2 py-0.5 rounded bg-muted text-[11px] font-mono text-muted-foreground">
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <pre className="text-xs whitespace-pre-wrap font-sans bg-transparent p-0 border-0 leading-relaxed">
                      {editingSkill?.content || '*(No playbook markdown provided)*'}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="mt-4 pt-3 border-t flex items-center justify-between sm:justify-between w-full">
            <div>
              {editingSkill?.id && editingSkill?.custom && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    const skillToDelete = editingSkill as SkillItem;
                    setSkillModalOpen(false);
                    confirmDeleteSkill(skillToDelete, e);
                  }}
                  className="text-destructive hover:bg-destructive/10 border-destructive/30 text-xs gap-1.5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete Skill</span>
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setSkillModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={editingSkill?.custom === false ? handleCopyBuiltInSkill : handleSaveSkill}
                disabled={
                  !editingSkill?.name?.trim() ||
                  !editingSkill?.description?.trim() ||
                  !editingSkill?.content?.trim()
                }
              >
                {editingSkill?.custom === false ? 'Create editable copy' : 'Save Skill'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Move to Category Menu Modal ────────────────────────────────────── */}
      <Dialog open={moveSkillModalOpen} onOpenChange={setMoveSkillModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move Skill to Category</DialogTitle>
            <DialogDescription>
              Select the destination category box for "{skillToMove?.title || skillToMove?.name}".
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            {categories.map((c) => {
              const Icon = ICON_MAP[c.icon || 'boxes'] || Boxes;
              const isCurrent = skillToMove?.category === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleExecuteMoveSkill(c.id)}
                  className={cn(
                    'w-full p-3 rounded-lg border text-left flex items-center justify-between transition-colors',
                    isCurrent
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted/50 text-foreground',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="p-1.5 rounded text-white flex items-center justify-center"
                      style={{ backgroundColor: c.color || '#3b82f6' }}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs">{c.name}</div>
                      {c.description && (
                        <div className="text-[11px] text-muted-foreground line-clamp-1">{c.description}</div>
                      )}
                    </div>
                  </div>
                  {isCurrent && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                </button>
              );
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMoveSkillModalOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation Modal ─────────────────────────────────────── */}
      <Dialog open={deleteConfirmModalOpen} onOpenChange={setDeleteConfirmModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Delete {deleteTarget?.type === 'category' ? 'Category' : (deleteTarget?.workspaceId ? 'Workspace Skill' : 'Global Skill')}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTarget?.title}"{deleteTarget?.workspaceId ? ` from workspace "${deleteTarget.workspaceId}"` : ''}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleExecuteDelete}>
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
