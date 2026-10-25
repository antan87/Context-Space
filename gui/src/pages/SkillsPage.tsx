import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  Plus,
  Trash2,
  Check,
  Code2,
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
  Eye,
  FileText,
} from 'lucide-react';

import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
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
  useDomainPacks,
} from '../lib/api/queries.js';
import { SkillDiagnosticsPanel } from '../features/skills/SkillDiagnosticsPanel.js';
import { SkillsExplorer } from '../features/skills/SkillsExplorer.js';
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
  // Category Modal State
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Partial<SkillCategory> | null>(null);

  // Skill Editor Modal State
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Partial<SkillItem> | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [skillModalTab, setSkillModalTab] = useState<'edit' | 'preview'>('edit');

  // Move-To Menu Modal State
  const [moveSkillModalOpen, setMoveSkillModalOpen] = useState(false);
  const [skillToMove, setSkillToMove] = useState<SkillItem | null>(null);

  // Delete Confirmation Modal State
  const [deleteConfirmModalOpen, setDeleteConfirmModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'category' | 'skill'; id: string; title: string } | null>(null);

  // Queries & Mutations
  const { data: categories = [] } = useSkillCategories();
  const { data: skills = [] } = useSkills();
  const { data: skillDiagnostics = [] } = useSkillDiagnostics();
  const { data: domainPacks = [] } = useDomainPacks();

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
      },
    );
    setSlugManuallyEdited(!!skill);
    setSkillModalTab('edit');
    setSkillModalOpen(true);
  };

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
        scope: 'global',
      });
      showToast?.('Skill saved to My library', 'success');
      setSkillModalOpen(false);
      setEditingSkill(null);
    } catch (err) {
      showToast?.(toErrorMessage(err, 'Failed to save skill'), 'error');
      console.error(err);
    }
  };

  const confirmDeleteSkill = (skill: SkillItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDeleteTarget({ type: 'skill', id: skill.id, title: skill.title || skill.name });
    setDeleteConfirmModalOpen(true);
  };

  const handleExecuteDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'category') {
        await deleteCategoryMutation.mutateAsync(deleteTarget.id);
        showToast?.('Category deleted', 'info');
      } else {
        await deleteSkillMutation.mutateAsync({ id: deleteTarget.id });
        showToast?.('Skill deleted from My library', 'info');
      }
      setDeleteConfirmModalOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      showToast?.(toErrorMessage(err, 'Failed to delete item'), 'error');
      console.error(err);
    }
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

  // ─── Move to Category (menu and drag and drop) ────────────────────────────

  const handleMoveToCategory = async (skill: SkillItem, targetCatId: string) => {
    if (!skill.custom || skill.category === targetCatId) return;
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
      showToast?.('Skill moved to category', 'success');
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
                My library: the skills you write, shared by every workspace.
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                To turn skills on for a workspace, open that workspace and use its Skills tab.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <Button render={<Link to="/agents" />} variant="outline" size="sm">Codex Agents</Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenCategoryModal()}
            className="flex items-center gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Category</span>
          </Button>
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

      <SkillsExplorer
        skills={skills}
        categories={categories}
        showToast={showToast}
        onEdit={(skill) => handleOpenSkillModal(skill)}
        onDelete={(skill) => confirmDeleteSkill(skill)}
        onMove={(skill, event) => handleOpenMoveModal(skill, event)}
        onMoveToCategory={handleMoveToCategory}
        onEditCategory={handleOpenCategoryModal}
        onDeleteCategory={confirmDeleteCategory}
      />

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
              Delete {deleteTarget?.type === 'category' ? 'Category' : 'Skill'}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === 'category'
                ? `Are you sure you want to delete "${deleteTarget.title}"? This action cannot be undone.`
                : `Are you sure you want to delete "${deleteTarget?.title}" from My library? This action cannot be undone.`}
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
