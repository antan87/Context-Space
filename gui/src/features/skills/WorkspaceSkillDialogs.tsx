import { useState, type ReactNode } from 'react';
import { BookOpen, Check, Code2, Edit2, Sparkles, X } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useSaveSkill } from '../../lib/api/queries.js';
import type { SkillItem } from '../../types.js';
import { skillOrigin } from './skillSelection.js';
import type { ShowToast } from './useAddToLibrary.js';

/** Reads one skill's SKILL.md. A skill the user can turn on or off here gets that button; one a tool ships gets whatever the caller offers. */
export function SkillPlaybookDialog({
  skill,
  isOn,
  onToggle,
  onEdit,
  onClose,
  extraAction,
}: {
  skill: SkillItem | null;
  isOn: boolean;
  onToggle?: () => void;
  onEdit?: (skill: SkillItem) => void;
  onClose: () => void;
  extraAction?: ReactNode;
}) {
  return (
    <Dialog open={!!skill} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="pb-3 border-b border-border/70 shrink-0">
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              <DialogTitle className="text-base font-bold">{skill?.title || skill?.name}</DialogTitle>
            </div>
            <Badge variant="outline" className="font-mono text-[10px]">
              {skill ? skillOrigin(skill) : ''}
            </Badge>
          </div>
          <DialogDescription className="text-xs text-muted-foreground mt-1">
            {skill?.description || 'No description provided.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {skill?.tags && skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] font-semibold text-muted-foreground mr-1">Tags:</span>
              {skill.tags.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px] font-mono">
                  #{t}
                </Badge>
              ))}
            </div>
          )}

          {skill?.allowedTools && skill.allowedTools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] font-semibold text-muted-foreground mr-1">Allowed Tools:</span>
              {skill.allowedTools.map((tool) => (
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
                {(skill?.content || '').split('\n').length} lines
              </span>
            </div>
            <div className="p-4 rounded-lg border border-border bg-card/60 overflow-x-auto">
              <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-foreground/90">
                {skill?.content || '*(Empty playbook)*'}
              </pre>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 pt-3 flex items-center justify-between sm:justify-between w-full">
          <div>
            {onToggle ? (
              <Button variant="outline" size="sm" onClick={onToggle} className="text-xs">
                {isOn ? (
                  <>
                    <X className="size-3.5 mr-1 text-destructive" />
                    Turn off for this workspace
                  </>
                ) : (
                  <>
                    <Check className="size-3.5 mr-1 text-primary" />
                    Turn on for this workspace
                  </>
                )}
              </Button>
            ) : extraAction}
          </div>
          <div className="flex items-center gap-2">
            {onEdit && skill && (
              <Button variant="outline" size="sm" onClick={() => onEdit(skill)} className="text-xs gap-1.5">
                <Edit2 className="size-3" />
                <span>Edit Playbook</span>
              </Button>
            )}
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A skill to create or change, and where it is saved: this workspace only, or My library. */
export interface SkillEditTarget {
  skill: Partial<SkillItem>;
  scope: 'workspace' | 'global';
}

export interface SavedSkill {
  id: string;
  category: string;
  isNew: boolean;
}

export function SkillEditorDialog({
  target,
  workspaceId,
  onClose,
  onSaved,
  showToast,
}: {
  target: SkillEditTarget | null;
  workspaceId: string;
  onClose: () => void;
  onSaved: (saved: SavedSkill) => void;
  showToast?: ShowToast;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      {target && <SkillEditorForm target={target} workspaceId={workspaceId} onClose={onClose} onSaved={onSaved} showToast={showToast} />}
    </Dialog>
  );
}

function SkillEditorForm({
  target,
  workspaceId,
  onClose,
  onSaved,
  showToast,
}: {
  target: SkillEditTarget;
  workspaceId: string;
  onClose: () => void;
  onSaved: (saved: SavedSkill) => void;
  showToast?: ShowToast;
}) {
  const saveSkillMutation = useSaveSkill();
  const [editingSkill, setEditingSkill] = useState<Partial<SkillItem>>(target.skill);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(Boolean(target.skill.id));
  const editingScope = target.scope;

  const handleTitleChange = (val: string) => {
    const next = { ...editingSkill, title: val };
    if (!editingSkill.id && !slugManuallyEdited) {
      next.name = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
    setEditingSkill(next);
  };

  const handleSaveSkill = async () => {
    if (!editingSkill.name?.trim() || !editingSkill.description?.trim() || !editingSkill.content?.trim()) {
      showToast?.('Skill name, trigger description, and playbook markdown are required', 'error');
      return;
    }
    const name = editingSkill.name.trim();
    try {
      await saveSkillMutation.mutateAsync({
        id: editingSkill.id,
        name,
        title: editingSkill.title || editingSkill.name,
        category: editingSkill.category || 'general',
        description: editingSkill.description || '',
        tags: editingSkill.tags || [],
        allowedTools: editingSkill.allowedTools || [],
        content: editingSkill.content,
        scope: editingScope,
        workspaceId: editingScope === 'workspace' ? workspaceId : undefined,
      });
      showToast?.(
        editingScope === 'workspace'
          ? `"${name}" saved for this workspace only, in .agents/skills/`
          : `"${name}" saved to My library`,
        'success',
      );
      onSaved({ id: name, category: editingSkill.category || 'general', isNew: !editingSkill.id });
      onClose();
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Failed to save skill', 'error');
    }
  };

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-6">
      <DialogHeader className="pb-3 border-b border-border/70 shrink-0">
        <div className="flex items-center justify-between pr-6">
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>{editingSkill.id ? 'Edit Skill Playbook' : 'Create New Skill'}</span>
          </DialogTitle>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground font-medium">Saved to:</span>
            <span className="font-mono text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
              {editingScope === 'workspace' ? `This workspace only (${workspaceId})` : 'My library'}
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
              value={editingSkill.title || ''}
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
              value={editingSkill.name || ''}
              disabled={!!editingSkill.id}
              onChange={(e) => {
                setSlugManuallyEdited(true);
                setEditingSkill((prev) => ({ ...prev, name: e.target.value }));
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
              value={editingSkill.category || ''}
              onChange={(e) => setEditingSkill((prev) => ({ ...prev, category: e.target.value }))}
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
              value={editingSkill.tags?.join(', ') || ''}
              onChange={(e) =>
                setEditingSkill((prev) => ({
                  ...prev,
                  tags: e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                }))
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
            value={editingSkill.description || ''}
            onChange={(e) => setEditingSkill((prev) => ({ ...prev, description: e.target.value }))}
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
              {(editingSkill.content || '').split('\n').length} lines
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Frontmatter (<code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">name</code>, <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">description</code>, <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">tags</code>) is auto-injected into <code className="font-mono text-[10px] bg-muted/60 px-1 py-0.2 rounded text-foreground">SKILL.md</code> on save.
          </p>
          <Textarea
            id="ws-skill-content"
            rows={12}
            value={editingSkill.content || ''}
            onChange={(e) => setEditingSkill((prev) => ({ ...prev, content: e.target.value }))}
            placeholder="# Playbook Title&#10;&#10;Detailed instructions for the AI assistant..."
            className="font-mono text-xs leading-relaxed resize-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <DialogFooter className="pt-3 border-t flex items-center justify-between sm:justify-between w-full">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSaveSkill} disabled={saveSkillMutation.isPending} className="gap-1.5">
          <Sparkles className="size-3.5" />
          <span>Save Skill</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
