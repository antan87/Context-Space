import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  Check,
  CheckSquare,
  Square,
  Search,
  Sparkles,
  ExternalLink,
  GitPullRequest,
  FlaskConical,
  Package,
  Database,
  ShieldCheck,
  Terminal,
  Zap,
  Cpu,
  Layers,
  Bot,
  X,
  ChevronDown,
  ChevronRight,
  Eye,
  Plus,
  Edit2,
  Code2,
  BookOpen,
  FolderGit2,
} from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Spinner } from '../../components/ui/spinner.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../components/ui/empty.js';
import { cn } from '../../lib/utils.js';
import {
  useSkillCategories,
  useSkills,
  useSkillDiagnostics,
  useAgents,
  useWorkspaceSkills,
  useAssignWorkspaceSkills,
  useRefreshWorkspace,
  useSaveSkill,
} from '../../lib/api/queries.js';
import { CONFIG_DIR } from '../../brand.js';
import { repoName } from '../../lib/status.js';
import type { Feature, SkillCategory, SkillItem } from '../../types.js';
import { SkillDiagnosticsPanel } from './SkillDiagnosticsPanel.js';

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
};

export interface WorkspaceSkillsTabProps {
  ws: Feature;
  showToast?: (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;
}

export function WorkspaceSkillsTab({ ws, showToast }: WorkspaceSkillsTabProps) {
  const { data: diagnostics = [] } = useSkillDiagnostics(ws.branchName);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [draftSkills, setDraftSkills] = useState<string[] | null>(null);
  const [draftAgents, setDraftAgents] = useState<string[] | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);

  // Inspection & Editing Modals
  const [previewSkill, setPreviewSkill] = useState<SkillItem | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Partial<SkillItem> | null>(null);
  const [editingScope, setEditingScope] = useState<'workspace' | 'global'>('workspace');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const { data: categories = [], isLoading: loadingCategories } = useSkillCategories();
  const { data: skills = [], isLoading: loadingSkills } = useSkills(ws.branchName);
  const { data: agents = [], isLoading: loadingAgents } = useAgents();
  const {
    data: workspaceSkillsConfig,
    isLoading: loadingWorkspaceConfig,
    isError: workspaceConfigError,
  } = useWorkspaceSkills(ws.branchName);

  const assignSkillsMutation = useAssignWorkspaceSkills();
  const refreshWorkspaceMutation = useRefreshWorkspace();
  const saveSkillMutation = useSaveSkill();

  const enabledSkillSet = useMemo(
    () => new Set(draftSkills ?? workspaceSkillsConfig?.enabledSkills ?? []),
    [draftSkills, workspaceSkillsConfig?.enabledSkills],
  );

  const enabledAgentSet = useMemo(
    () => new Set(draftAgents ?? workspaceSkillsConfig?.enabledAgents ?? []),
    [draftAgents, workspaceSkillsConfig?.enabledAgents],
  );

  // Sync draft state when workspace config loads/changes
  useEffect(() => {
    if (workspaceSkillsConfig) {
      setDraftSkills([...(workspaceSkillsConfig.enabledSkills ?? [])]);
      setDraftAgents([...(workspaceSkillsConfig.enabledAgents ?? [])]);
    }
  }, [workspaceSkillsConfig]);

  const hasUnsavedChanges = useMemo(() => {
    if (!workspaceSkillsConfig || draftSkills === null || draftAgents === null) return false;
    const currentSkills = new Set(workspaceSkillsConfig.enabledSkills ?? []);
    const currentAgents = new Set(workspaceSkillsConfig.enabledAgents ?? []);

    if (draftSkills.length !== currentSkills.size || draftSkills.some((s) => !currentSkills.has(s))) {
      return true;
    }
    if (draftAgents.length !== currentAgents.size || draftAgents.some((a) => !currentAgents.has(a))) {
      return true;
    }
    return false;
  }, [workspaceSkillsConfig, draftSkills, draftAgents]);

  const toggleCategoryCollapse = (catId: string) => {
    setCollapsedCategories((prev) => ({ ...prev, [catId]: !prev[catId] }));
  };

  const handleToggleSkill = (skillId: string) => {
    if (draftSkills === null) return;
    const next = new Set(draftSkills);
    if (next.has(skillId)) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    setDraftSkills(Array.from(next));
  };

  const handleToggleAgent = (agentId: string) => {
    if (draftAgents === null) return;
    const next = new Set(draftAgents);
    if (next.has(agentId)) {
      next.delete(agentId);
    } else {
      next.add(agentId);
    }
    setDraftAgents(Array.from(next));
  };

  const handleToggleCategory = (_catId: string, enable: boolean, categorySkills: SkillItem[]) => {
    if (draftSkills === null) return;
    const next = new Set(draftSkills);
    for (const skill of categorySkills) {
      if (enable) {
        next.add(skill.id);
      } else {
        next.delete(skill.id);
      }
    }
    setDraftSkills(Array.from(next));
  };

  const handleSaveAndDeploy = async () => {
    if (!workspaceSkillsConfig || draftSkills === null || draftAgents === null) return;
    setIsDeploying(true);
    try {
      await assignSkillsMutation.mutateAsync({
        workspaceId: ws.branchName,
        expectedRevision: workspaceSkillsConfig.revision ?? 0,
        enabledSkills: draftSkills,
        enabledAgents: draftAgents,
        enabledCategories: categories.map((category) => category.id),
      });

      await refreshWorkspaceMutation.mutateAsync({
        workspaceId: ws.branchName,
      });

      showToast?.('Skills & agents deployed successfully to workspace context!', 'success');
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : 'Failed to deploy skills', 'error');
    } finally {
      setIsDeploying(false);
    }
  };

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.title?.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }, [skills, searchQuery]);

  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const q = searchQuery.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    );
  }, [agents, searchQuery]);

  // Merge registered categories with auto-discovered categories from skills
  const { displayCategories, uncategorizedSkills } = useMemo(() => {
    const knownCategoryIds = new Set(categories.map((c) => c.id));
    const mergedCategories = categories.filter((category) => category.id !== 'general');

    const extraCategoryMap = new Map<string, SkillCategory>();
    for (const skill of filteredSkills) {
      if (skill.category && skill.category !== 'general' && !knownCategoryIds.has(skill.category)) {
        if (!extraCategoryMap.has(skill.category)) {
          const formattedName = skill.category
            .split(/[-_]/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
          extraCategoryMap.set(skill.category, {
            id: skill.category,
            name: formattedName,
            description: `Skills categorized under ${formattedName}`,
            color: '#3b82f6',
            icon: 'boxes',
          });
        }
      }
    }

    mergedCategories.push(...Array.from(extraCategoryMap.values()));
    const allCatIds = new Set(mergedCategories.map((c) => c.id));
    const uncategorized = filteredSkills.filter((s) => !s.category || !allCatIds.has(s.category));

    return {
      displayCategories: mergedCategories,
      uncategorizedSkills: uncategorized,
    };
  }, [categories, filteredSkills]);

  const skillsByCategory = useMemo(() => {
    const acc: Record<string, SkillItem[]> = {};
    for (const cat of displayCategories) {
      acc[cat.id] = filteredSkills.filter((s) => s.category === cat.id);
    }
    return acc;
  }, [displayCategories, filteredSkills]);

  // Handlers for Modals
  const handleOpenPreview = (skill: SkillItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewSkill(skill);
  };

  const handleOpenEdit = (skill: SkillItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSkill({ ...skill });
    setEditingScope(skill.scope === 'workspace' ? 'workspace' : 'global');
    setSlugManuallyEdited(true);
    setEditModalOpen(true);
  };

  const handleOpenCreateSkill = () => {
    setEditingSkill({
      name: '',
      title: '',
      category: displayCategories[0]?.id || 'general',
      description: '',
      tags: [],
      content: '# Skill Title\n\nProcedural playbook instructions for AI assistants...',
      allowedTools: [],
    });
    setEditingScope('workspace');
    setSlugManuallyEdited(false);
    setEditModalOpen(true);
  };

  const handleTitleChange = (val: string) => {
    const next = { ...(editingSkill || {}), title: val };
    if (!editingSkill?.id && !slugManuallyEdited) {
      next.name = val
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
      showToast?.('Skill name, trigger description, and playbook markdown are required', 'error');
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
        scope: editingScope,
        workspaceId: editingScope === 'workspace' ? ws.branchName : undefined,
      });

      if (draftSkills !== null && !draftSkills.includes(editingSkill.name.trim())) {
        setDraftSkills([...draftSkills, editingSkill.name.trim()]);
      }

      showToast?.(
        editingScope === 'workspace'
          ? `Workspace skill '${editingSkill.name}' saved to .agents/skills/`
          : `Global skill '${editingSkill.name}' saved to catalog`,
        'success',
      );
      setEditModalOpen(false);
      setEditingSkill(null);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Failed to save skill', 'error');
    }
  };

  const isLoading = loadingCategories || loadingSkills || loadingAgents || loadingWorkspaceConfig;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 gap-3 text-muted-foreground">
        <Spinner />
        <span className="text-sm">Loading workspace skills...</span>
      </div>
    );
  }

  if (workspaceConfigError) {
    return (
      <Empty className="py-12 border border-dashed rounded-xl">
        <EmptyHeader>
          <EmptyTitle>Could not load workspace skills config</EmptyTitle>
          <EmptyDescription>Unable to read .contextspace/skills.json for this workspace.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const renderSkillCard = (skill: SkillItem) => {
    const isEnabled = enabledSkillSet.has(skill.id);
    return (
      <div
        key={skill.id}
        role="button"
        tabIndex={0}
        onClick={() => handleToggleSkill(skill.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggleSkill(skill.id);
          }
        }}
        className={cn(
          'p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between select-none shadow-2xs group',
          isEnabled
            ? 'border-primary/60 bg-primary/5 text-foreground'
            : 'border-border bg-card/70 text-muted-foreground hover:border-foreground/20 hover:text-foreground',
        )}
      >
        <div>
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded border transition-colors',
                  isEnabled
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-transparent',
                )}
              >
                {isEnabled && <Check className="size-3 stroke-[3]" />}
              </span>
              <span className="font-mono text-xs font-semibold truncate">
                {skill.title || skill.name}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <Badge
                variant={skill.scope === 'workspace' ? 'default' : 'outline'}
                className="text-[9px] px-1 py-0 font-mono"
                title={
                  skill.scope === 'workspace'
                    ? 'Local to this workspace (.agents/skills/)'
                    : 'From global catalog (~/.contextspace/skills/)'
                }
              >
                {skill.scope === 'workspace' ? 'Workspace' : 'Global'}
              </Badge>
              <Button
                variant="ghost"
                size="xs"
                onClick={(e) => handleOpenPreview(skill, e)}
                title="Inspect Playbook Instructions"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Eye className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={(e) => handleOpenEdit(skill, e)}
                title="Edit Skill Playbook"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Edit2 className="size-3" />
              </Button>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed pl-6">
            {skill.description || 'No description provided.'}
          </p>

          {skill.tags && skill.tags.length > 0 && (
            <div className="mt-2 pl-6 flex items-center gap-1 flex-wrap">
              {skill.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="text-[9px] font-mono text-muted-foreground bg-muted/60 px-1 py-0.2 rounded"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <SkillDiagnosticsPanel diagnostics={diagnostics} />
      {/* Top Banner / Actions Bar */}
      <Card className="p-3.5 sm:p-4 rounded-xl border border-border/40 bg-card/60 backdrop-blur-xs shadow-2xs flex flex-col gap-3">
        <div className="flex items-start gap-3 min-w-0 w-full">
          <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5 sm:mt-0">
            <Boxes className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground whitespace-nowrap">Workspace Skills &amp; Agents</h3>
              <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5 shrink-0">
                {enabledSkillSet.size} Skills Active
              </Badge>
              {enabledAgentSet.size > 0 && (
                <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5 shrink-0">
                  {enabledAgentSet.size} Agents Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Select skills to deploy to this workspace. Authored .agents/skills files remain discoverable by assistants even when deselected.
            </p>
            {ws.repos && ws.repos.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Target repositories:</span>
                {ws.repos.map((rp) => (
                  <span key={rp} className="inline-flex items-center gap-1 font-mono text-[10px] bg-muted/60 px-1.5 py-0.5 rounded border border-border/50 text-foreground">
                    <FolderGit2 className="size-3 text-primary" />
                    {repoName(rp)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={handleOpenCreateSkill}
            className="h-7 px-2.5 text-xs flex items-center gap-1.5 shadow-2xs"
          >
            <Plus className="size-3" />
            <span>New Skill</span>
          </Button>

          <Button
            size="xs"
            variant={hasUnsavedChanges ? 'default' : 'outline'}
            onClick={handleSaveAndDeploy}
            disabled={isDeploying || (!hasUnsavedChanges && enabledSkillSet.size === 0 && enabledAgentSet.size === 0)}
            className="h-7 px-3 text-xs font-medium flex items-center gap-1.5 shadow-2xs"
          >
            {isDeploying ? <Spinner className="size-3" /> : <Sparkles className="size-3" />}
            <span>{isDeploying ? 'Deploying…' : hasUnsavedChanges ? 'Save & Deploy Changes' : 'Re-Deploy to Workspace'}</span>
          </Button>

          <Button
            render={<Link to="/skills" />}
            variant="ghost"
            size="xs"
            className="h-7 px-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            title="Open Global Enterprise Catalog"
          >
            <ExternalLink className="size-3" />
            <span>Global Library</span>
          </Button>
        </div>
      </Card>

      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter skills & agents by keyword or tag..."
          className="pl-9 pr-8 h-8 text-xs bg-card"
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

      {/* Categorized Skills Accordions */}
      <div className="space-y-3">
        {displayCategories.map((category) => {
          const IconComp = ICON_MAP[category.icon || 'boxes'] || Boxes;
          const catSkills = skillsByCategory[category.id] || [];
          if (catSkills.length === 0) return null;

          const isCollapsed = !!collapsedCategories[category.id];
          const allCatEnabled = catSkills.length > 0 && catSkills.every((s) => enabledSkillSet.has(s.id));

          return (
            <div
              key={category.id}
              className="border border-border rounded-xl overflow-hidden bg-card/60 transition-colors"
            >
              {/* Category Header */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                onClick={() => toggleCategoryCollapse(category.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleCategoryCollapse(category.id);
                  }
                }}
                className="p-3 flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors select-none"
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="p-1.5 rounded-md text-white shadow-xs flex items-center justify-center"
                    style={{ backgroundColor: category.color || '#3b82f6' }}
                  >
                    <IconComp className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-xs text-foreground">{category.name}</h4>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
                        {catSkills.filter((s) => enabledSkillSet.has(s.id)).length}/{catSkills.length} active
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {catSkills.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => handleToggleCategory(category.id, !allCatEnabled, catSkills)}
                      className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
                    >
                      {allCatEnabled ? (
                        <CheckSquare className="h-3 w-3 mr-1 text-primary" />
                      ) : (
                        <Square className="h-3 w-3 mr-1" />
                      )}
                      <span>{allCatEnabled ? 'Deselect All' : 'Select All'}</span>
                    </Button>
                  )}
                  <div className="p-0.5 text-muted-foreground">
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>
              </div>

              {/* Skills Grid */}
              {!isCollapsed && (
                <div className="p-3 border-t border-border/40 bg-background/50">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {catSkills.map((skill) => renderSkillCard(skill))}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Uncategorized Skills Section */}
        {uncategorizedSkills.length > 0 && (
          <div className="border border-border rounded-xl overflow-hidden bg-card/60 transition-colors">
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!collapsedCategories['__uncategorized']}
              onClick={() => toggleCategoryCollapse('__uncategorized')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleCategoryCollapse('__uncategorized');
                }
              }}
              className="p-3 flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors select-none"
            >
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-md bg-muted text-muted-foreground shadow-xs flex items-center justify-center">
                  <Boxes className="h-3.5 w-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-xs text-foreground">Uncategorized Skills</h4>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
                      {uncategorizedSkills.filter((s) => enabledSkillSet.has(s.id)).length}/{uncategorizedSkills.length} active
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    handleToggleCategory(
                      '__uncategorized',
                      !uncategorizedSkills.every((s) => enabledSkillSet.has(s.id)),
                      uncategorizedSkills,
                    )
                  }
                  className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
                >
                  {uncategorizedSkills.every((s) => enabledSkillSet.has(s.id)) ? (
                    <CheckSquare className="h-3 w-3 mr-1 text-primary" />
                  ) : (
                    <Square className="h-3 w-3 mr-1" />
                  )}
                  <span>
                    {uncategorizedSkills.every((s) => enabledSkillSet.has(s.id))
                      ? 'Deselect All'
                      : 'Select All'}
                  </span>
                </Button>
                <div className="p-0.5 text-muted-foreground">
                  {collapsedCategories['__uncategorized'] ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </div>
            </div>

            {!collapsedCategories['__uncategorized'] && (
              <div className="p-3 border-t border-border/40 bg-background/50">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {uncategorizedSkills.map((skill) => renderSkillCard(skill))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Custom Codex Agents Section */}
        {filteredAgents.length > 0 && (
          <div className="border border-border rounded-xl overflow-hidden bg-card/60 transition-colors">
            <div className="p-3 flex items-center justify-between border-b border-border/40 select-none">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-md bg-purple-600 text-white shadow-xs flex items-center justify-center">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-xs text-foreground">Codex Native Agents</h4>
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      {filteredAgents.filter((a) => enabledAgentSet.has(a.id)).length}/{filteredAgents.length} active
                    </Badge>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-3 bg-background/50">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {filteredAgents.map((agent) => {
                  const isEnabled = enabledAgentSet.has(agent.id);
                  return (
                    <div
                      key={agent.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleToggleAgent(agent.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggleAgent(agent.id);
                        }
                      }}
                      className={cn(
                        'p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between select-none shadow-2xs',
                        isEnabled
                          ? 'border-purple-500/60 bg-purple-500/5 text-foreground'
                          : 'border-border bg-card/70 text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={cn(
                              'grid size-4 shrink-0 place-items-center rounded border transition-colors',
                              isEnabled
                                ? 'border-purple-600 bg-purple-600 text-white'
                                : 'border-muted-foreground/40 bg-transparent',
                            )}
                          >
                            {isEnabled && <Check className="size-3 stroke-[3]" />}
                          </span>
                          <span className="font-mono text-xs font-semibold truncate">{agent.name}</span>
                        </div>
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 shrink-0">
                          .codex/agents
                        </Badge>
                      </div>

                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed pl-6">
                        {agent.description || 'No description provided.'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Empty state if nothing matches */}
        {displayCategories.every((c) => (skillsByCategory[c.id] || []).length === 0) &&
          uncategorizedSkills.length === 0 &&
          filteredAgents.length === 0 && (
            <Empty className="py-12 border border-dashed rounded-xl">
              <EmptyHeader>
                <EmptyTitle>No skills found</EmptyTitle>
                <EmptyDescription>
                  {searchQuery
                    ? `No skills match the filter "${searchQuery}".`
                    : 'No skills configured in this workspace yet. Click "+ New Skill" to create a playbook or attach one from the catalog.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Saving & deploying will write to <code className="font-mono text-xs text-foreground">{CONFIG_DIR}/skills.json</code> and materialize files into <code className="font-mono text-xs text-foreground">.agents/skills/</code>, <code className="font-mono text-xs text-foreground">.claude/skills/</code>, and <code className="font-mono text-xs text-foreground">.codex/agents/</code>.
      </p>

      {/* ─── Skill Playbook Inspection Modal ───────────────────────────────── */}
      <Dialog open={!!previewSkill} onOpenChange={(open) => !open && setPreviewSkill(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
          <DialogHeader className="pb-3 border-b border-border/70 shrink-0">
            <div className="flex items-center justify-between pr-6">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" />
                <DialogTitle className="text-base font-bold">
                  {previewSkill?.title || previewSkill?.name}
                </DialogTitle>
              </div>
              <Badge variant="outline" className="font-mono text-[10px]">
                {previewSkill?.scope === 'workspace' ? 'Workspace (.agents/skills/)' : 'Global Catalog'}
              </Badge>
            </div>
            <DialogDescription className="text-xs text-muted-foreground mt-1">
              {previewSkill?.description || 'No description provided.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {previewSkill?.tags && previewSkill.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[11px] font-semibold text-muted-foreground mr-1">Tags:</span>
                {previewSkill.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px] font-mono">
                    #{t}
                  </Badge>
                ))}
              </div>
            )}

            {previewSkill?.allowedTools && previewSkill.allowedTools.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[11px] font-semibold text-muted-foreground mr-1">Allowed Tools:</span>
                {previewSkill.allowedTools.map((tool) => (
                  <code key={tool} className="text-[10px] font-mono bg-muted/60 px-1.5 py-0.5 rounded text-foreground">
                    {tool}
                  </code>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                <span className="flex items-center gap-1.5">
                  <Code2 className="h-3.5 w-3.5 text-primary" />
                  <span>SKILL.md Playbook Instructions</span>
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {(previewSkill?.content || '').split('\n').length} lines
                </span>
              </div>
              <div className="p-4 rounded-lg border border-border bg-card/60 overflow-x-auto">
                <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-foreground/90">
                  {previewSkill?.content || '*(Empty playbook)*'}
                </pre>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border/70 pt-3 flex items-center justify-between sm:justify-between w-full">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (previewSkill) {
                  handleToggleSkill(previewSkill.id);
                }
              }}
              className="text-xs"
            >
              {previewSkill && enabledSkillSet.has(previewSkill.id) ? (
                <>
                  <X className="size-3.5 mr-1 text-destructive" />
                  Deactivate for Workspace
                </>
              ) : (
                <>
                  <Check className="size-3.5 mr-1 text-primary" />
                  Activate for Workspace
                </>
              )}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  if (previewSkill) {
                    const s = previewSkill;
                    setPreviewSkill(null);
                    handleOpenEdit(s, e);
                  }
                }}
                className="text-xs gap-1.5"
              >
                <Edit2 className="size-3" />
                <span>Edit Playbook</span>
              </Button>
              <Button size="sm" onClick={() => setPreviewSkill(null)}>
                Close
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Skill Create / Edit Dialog ────────────────────────────────────── */}
      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-6">
          <DialogHeader className="pb-3 border-b border-border/70 shrink-0">
            <div className="flex items-center justify-between pr-6">
              <DialogTitle className="text-base font-bold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span>{editingSkill?.id ? 'Edit Skill Playbook' : 'Create New Skill'}</span>
              </DialogTitle>
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground font-medium">Scope:</span>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                  {editingScope === 'workspace' ? `Workspace (${ws.branchName})` : 'Global Catalog'}
                </span>
              </div>
            </div>
            <DialogDescription className="text-xs text-muted-foreground mt-0.5">
              Configure SKILL.md metadata triggers and markdown instructions.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-3 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ws-skill-title" className="text-xs font-medium">
                  Display Title
                </Label>
                <Input
                  id="ws-skill-title"
                  value={editingSkill?.title || ''}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  placeholder="e.g. NexusFlow Dev Playbook"
                  className="mt-1 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="ws-skill-name" className="text-xs font-medium">
                  Identifier (Slug)
                </Label>
                <Input
                  id="ws-skill-name"
                  value={editingSkill?.name || ''}
                  disabled={!!editingSkill?.id}
                  onChange={(e) => {
                    setSlugManuallyEdited(true);
                    setEditingSkill((prev) => (prev ? { ...prev, name: e.target.value } : null));
                  }}
                  placeholder="e.g. nexusflow-dev"
                  className="mt-1 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ws-skill-category" className="text-xs font-medium">
                  Category
                </Label>
                <Input
                  id="ws-skill-category"
                  value={editingSkill?.category || ''}
                  onChange={(e) =>
                    setEditingSkill((prev) => (prev ? { ...prev, category: e.target.value } : null))
                  }
                  placeholder="e.g. dev-standards or workflows"
                  className="mt-1 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="ws-skill-tags" className="text-xs font-medium">
                  Tags (comma separated)
                </Label>
                <Input
                  id="ws-skill-tags"
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
                  placeholder="e.g. nexusflow, testing, cli"
                  className="mt-1 text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="ws-skill-desc" className="text-xs font-medium">
                Trigger Description (When should the assistant use this skill?)
              </Label>
              <Textarea
                id="ws-skill-desc"
                rows={2}
                value={editingSkill?.description || ''}
                onChange={(e) =>
                  setEditingSkill((prev) => (prev ? { ...prev, description: e.target.value } : null))
                }
                placeholder="e.g. Use when developing, debugging, refactoring, or maintaining NexusFlow code..."
                className="mt-1 text-xs leading-relaxed resize-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="ws-skill-content" className="text-xs font-semibold flex items-center gap-1.5">
                  <Code2 className="h-3.5 w-3.5 text-primary" />
                  <span>Playbook Instructions (Markdown)</span>
                </Label>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {(editingSkill?.content || '').split('\n').length} lines
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Frontmatter (<code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">name</code>, <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">description</code>, <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">tags</code>) is auto-injected into <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">SKILL.md</code> on save.
              </p>
              <Textarea
                id="ws-skill-content"
                rows={12}
                value={editingSkill?.content || ''}
                onChange={(e) =>
                  setEditingSkill((prev) => (prev ? { ...prev, content: e.target.value } : null))
                }
                placeholder="# Playbook Title&#10;&#10;Detailed instructions for the AI assistant..."
                className="font-mono text-xs leading-relaxed resize-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <DialogFooter className="pt-3 border-t flex items-center justify-between sm:justify-between w-full">
            <Button variant="outline" size="sm" onClick={() => setEditModalOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveSkill} className="gap-1.5">
              <Sparkles className="size-3.5" />
              <span>Save Skill</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
