import type { Feature, SkillItem } from '../../types.js';

/**
 * A choice of enabled skills that is made but not saved. It keeps the revision it started from, so saving it asks the
 * server to refuse if someone saved a different selection in between, instead of replacing theirs without a word.
 */
export interface SelectionDraft {
  skills: string[];
  revision: number;
}

/** What the server has for a workspace. */
export interface SavedSelection {
  enabledSkills: readonly string[];
  revision?: number;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** The enabled skills to show: the unsaved choice for this workspace, else what is saved. Null until that is known. */
export function selectionFor(draft: SelectionDraft | undefined, saved: SavedSelection | undefined): string[] | null {
  if (draft) return draft.skills;
  return saved ? [...saved.enabledSkills] : null;
}

/** The draft after one skill is switched on or off, starting from what is saved when there is no draft yet. */
export function toggled(draft: SelectionDraft | undefined, saved: SavedSelection, skillId: string): SelectionDraft {
  const skills = new Set(draft?.skills ?? saved.enabledSkills);
  if (skills.has(skillId)) skills.delete(skillId);
  else skills.add(skillId);
  return { skills: [...skills], revision: draft?.revision ?? saved.revision ?? 0 };
}

/** The draft after a whole group is switched on or off. */
export function groupToggled(draft: SelectionDraft | undefined, saved: SavedSelection, skillIds: readonly string[], enable: boolean): SelectionDraft {
  const skills = new Set(draft?.skills ?? saved.enabledSkills);
  for (const id of skillIds) {
    if (enable) skills.add(id);
    else skills.delete(id);
  }
  return { skills: [...skills], revision: draft?.revision ?? saved.revision ?? 0 };
}

/**
 * `saved`: nothing to save. `unsaved`: a choice waiting to be saved. `outdated`: that choice began from a selection
 * that has since changed on the server, so saving it would be refused.
 */
export function selectionState(draft: SelectionDraft | undefined, saved: SavedSelection | undefined): 'saved' | 'unsaved' | 'outdated' {
  if (!draft || !saved || sameIds(draft.skills, saved.enabledSkills)) return 'saved';
  return draft.revision === (saved.revision ?? 0) ? 'unsaved' : 'outdated';
}

/**
 * Whether the trash button is offered. In the catalog view that is the machine-wide skills a person made; in a
 * workspace's view only that workspace's own packages, because a click there must not delete what every workspace uses.
 */
export function canDeleteSkill(skill: Pick<SkillItem, 'custom' | 'scope'>, viewingWorkspace: boolean): boolean {
  if (!skill.custom) return false;
  return viewingWorkspace ? skill.scope === 'workspace' : skill.scope !== 'workspace';
}

/**
 * The workspace a delete must name, or none for the global catalog. It follows the skill and the page being viewed,
 * never what the editor was last open on: the server looks only in the workspace named, so a stale name made a
 * global skill impossible to delete ("Skill not found").
 */
export function deleteWorkspaceFor(skill: Pick<SkillItem, 'scope'>, viewedWorkspace: string): string | undefined {
  return skill.scope === 'workspace' && viewedWorkspace !== 'global' ? viewedWorkspace : undefined;
}

/** Whether a skill matches a search: its title, name, description, tags, or a tool it may use. */
export function matchesSkillSearch(skill: Pick<SkillItem, 'title' | 'name' | 'description' | 'tags' | 'allowedTools'>, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return Boolean(
    skill.title?.toLowerCase().includes(query)
    || skill.name.toLowerCase().includes(query)
    || skill.description?.toLowerCase().includes(query)
    || skill.tags?.some((tag) => tag.toLowerCase().includes(query))
    || skill.allowedTools?.some((tool) => tool.toLowerCase().includes(query)),
  );
}

/** Workspaces a new workspace skill can be written into: archived ones have given their worktrees back. */
export function skillTargets<T extends Pick<Feature, 'archivedAt'>>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => !workspace.archivedAt);
}

/** How a workspace is named in a list of scopes: by name, with its id when that differs, and marked when archived. */
export function scopeLabel(workspace: Pick<Feature, 'id' | 'branchName' | 'name' | 'archivedAt'>): string {
  const name = workspace.name?.trim() || workspace.id;
  const detail = name.toLowerCase() === workspace.branchName.toLowerCase() ? '' : ` (${workspace.branchName})`;
  return `${name}${detail}${workspace.archivedAt ? ' · archived' : ''}`;
}
