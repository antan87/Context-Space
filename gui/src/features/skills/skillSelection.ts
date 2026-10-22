import type { SkillCategory, SkillItem, WorkspaceSkillsConfig } from '../../types.js';

/**
 * Which skills a workspace gets. One rule, the same one the server applies when it writes the workspace:
 *
 *   every skill whose category is turned on (now and later)
 *   + every skill picked one by one
 *   - every skill left out (an exception)
 *
 * Skills a tool ships itself (`source` set) are always on in that tool and never part of this choice.
 */
export interface SkillChoice {
  /** Categories turned on. */
  categories: string[];
  /** Skills picked one by one. */
  picks: string[];
  /** Skills left out although a turned-on category or a pick would bring them in. */
  exceptions: string[];
}

type CatalogSkill = Pick<SkillItem, 'id' | 'category' | 'source'>;

/** A skill the user can turn on for a workspace: one of theirs, not one a tool ships. */
export const isSelectable = (skill: Pick<SkillItem, 'source'>): boolean => !skill.source;

/** A skill in My library: written by the user, shared by every workspace. */
export const isLibrarySkill = (skill: Pick<SkillItem, 'source' | 'scope'>): boolean => !skill.source && skill.scope !== 'workspace';

/** A skill written inside one workspace. */
export const isWorkspaceOnlySkill = (skill: Pick<SkillItem, 'source' | 'scope'>): boolean => !skill.source && skill.scope === 'workspace';

/** Why a skill is on, or why it is off though something would have brought it in. */
export type SkillWhy = 'category' | 'picked' | 'left-out';

export interface SkillStatus {
  on: boolean;
  why: SkillWhy | null;
}

export function skillStatus(skill: CatalogSkill, choice: SkillChoice): SkillStatus {
  if (!isSelectable(skill)) return { on: false, why: null };
  const viaCategory = Boolean(skill.category) && choice.categories.includes(skill.category);
  const picked = choice.picks.includes(skill.id);
  if (choice.exceptions.includes(skill.id)) return { on: false, why: viaCategory || picked ? 'left-out' : null };
  if (viaCategory) return { on: true, why: 'category' };
  if (picked) return { on: true, why: 'picked' };
  return { on: false, why: null };
}

/** Whether a turned-on category brings this skill in, whether or not it was then left out. */
export const coveredByCategory = (skill: CatalogSkill, choice: SkillChoice): boolean =>
  isSelectable(skill) && Boolean(skill.category) && choice.categories.includes(skill.category);

/** The ids this choice turns on, in the order the skills are given. */
export function onSkillIds(skills: readonly CatalogSkill[], choice: SkillChoice): string[] {
  return skills.filter((skill) => skillStatus(skill, choice).on).map((skill) => skill.id);
}

const without = (ids: readonly string[], remove: ReadonlySet<string> | string) =>
  ids.filter((id) => (typeof remove === 'string' ? id !== remove : !remove.has(id)));
const withId = (ids: readonly string[], id: string) => (ids.includes(id) ? [...ids] : [...ids, id]);

/**
 * A category turned on or off. Turning it on takes in every skill in it, so a skill left out earlier comes back;
 * turning it off drops those exceptions too, since there is nothing left to leave out. Skills picked one by one stay picked.
 */
export function setCategory(choice: SkillChoice, skills: readonly CatalogSkill[], categoryId: string, on: boolean): SkillChoice {
  const members = new Set(skills.filter((skill) => skill.category === categoryId).map((skill) => skill.id));
  return {
    categories: on ? withId(choice.categories, categoryId) : without(choice.categories, categoryId),
    picks: [...choice.picks],
    exceptions: without(choice.exceptions, members),
  };
}

/**
 * One skill switched on or off. Inside a turned-on category that leaves it out (or takes it back in); anywhere else it
 * is picked or unpicked on its own. A skill that is not selectable (a tool's own) is never changed.
 */
export function toggleSkill(choice: SkillChoice, skill: CatalogSkill): SkillChoice {
  if (!isSelectable(skill)) return choice;
  const covered = coveredByCategory(skill, choice);
  if (skillStatus(skill, choice).on) {
    return covered
      ? { ...choice, picks: without(choice.picks, skill.id), exceptions: withId(choice.exceptions, skill.id) }
      : { ...choice, picks: without(choice.picks, skill.id) };
  }
  const exceptions = without(choice.exceptions, skill.id);
  return covered ? { ...choice, exceptions } : { ...choice, picks: withId(choice.picks, skill.id), exceptions };
}

/** Skills picked one by one, in bulk (Select All). */
export function pickAll(choice: SkillChoice, skills: readonly CatalogSkill[]): SkillChoice {
  const ids = new Set(skills.filter(isSelectable).map((skill) => skill.id));
  return { ...choice, picks: [...new Set([...choice.picks, ...ids])], exceptions: without(choice.exceptions, ids) };
}

/** The categories a saved config subscribes to. A version 1 file listed every registered category, so it names none. */
export function subscribedCategories(config: Pick<WorkspaceSkillsConfig, 'schemaVersion' | 'enabledCategories'> | undefined): string[] {
  return config?.schemaVersion === 2 ? [...(config.enabledCategories ?? [])] : [];
}

/**
 * The choice a saved config stands for, as the screen should show it.
 *
 * - Ids that name a skill a tool ships, or no skill at all, are dropped: the server drops them too.
 * - A skill the server turns on that this config does not explain (a workspace's own skills on a workspace that never saved
 *   a selection) becomes a pick, so the screen shows what the tools see and saving keeps it.
 */
export function choiceFromConfig(
  config: WorkspaceSkillsConfig,
  skills: readonly CatalogSkill[],
  resolvedSkills: readonly string[] = [],
): SkillChoice {
  const known = new Set(skills.filter(isSelectable).map((skill) => skill.id));
  const base: SkillChoice = {
    categories: subscribedCategories(config),
    picks: (config.enabledSkills ?? []).filter((id) => known.has(id)),
    exceptions: (config.disabledSkills ?? []).filter((id) => known.has(id)),
  };
  const explained = new Set(onSkillIds(skills, base));
  const unexplained = resolvedSkills.filter((id) => known.has(id) && !explained.has(id) && !base.exceptions.includes(id));
  return { ...base, picks: [...base.picks, ...unexplained] };
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export const sameChoice = (a: SkillChoice, b: SkillChoice): boolean =>
  sameIds(a.categories, b.categories) && sameIds(a.picks, b.picks) && sameIds(a.exceptions, b.exceptions);

/**
 * A change to a workspace's skills and agents that is made but not saved. It keeps the revision it started from, so saving
 * it asks the server to refuse if someone saved a different selection in between, instead of replacing theirs without a word.
 */
export interface SelectionDraft {
  choice: SkillChoice;
  agents: string[];
  revision: number;
}

/** What the server has for a workspace. */
export interface SavedSelection {
  choice: SkillChoice;
  agents: readonly string[];
  revision: number;
}

/**
 * `saved`: nothing to save. `unsaved`: a change waiting to be saved. `outdated`: that change began from a selection
 * that has since changed on the server, so saving it would be refused.
 */
export function selectionState(draft: SelectionDraft | null, saved: SavedSelection | undefined): 'saved' | 'unsaved' | 'outdated' {
  if (!draft || !saved || (sameChoice(draft.choice, saved.choice) && sameIds(draft.agents, saved.agents))) return 'saved';
  return draft.revision === saved.revision ? 'unsaved' : 'outdated';
}

/** A category as the workspace screens show it: what it is called, who is in it, and whether it is on. */
export interface CategoryGroup {
  id: string;
  name: string;
  description: string;
  color?: string;
  icon?: string;
  /** My library skills in this category. */
  members: SkillItem[];
  on: boolean;
}

const titleCase = (id: string) => id.split(/[-_]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/**
 * Every category a workspace can turn on: the registered ones, those only some skill names, and any the workspace already
 * turned on whose skills are gone. "general" is where a skill with no category lands, so it is not offered as a category
 * unless it is already on.
 */
export function categoryGroups(
  registered: readonly SkillCategory[],
  skills: readonly SkillItem[],
  turnedOn: readonly string[],
): CategoryGroup[] {
  const library = skills.filter(isLibrarySkill);
  const groups = new Map<string, CategoryGroup>();
  const add = (id: string, from?: SkillCategory) => {
    if (!id || groups.has(id) || (id === 'general' && !turnedOn.includes(id))) return;
    const name = from?.name || titleCase(id);
    groups.set(id, {
      id,
      name,
      description: from?.description ?? '',
      color: from?.color,
      icon: from?.icon,
      members: library.filter((skill) => skill.category === id),
      on: turnedOn.includes(id),
    });
  };
  for (const category of registered) add(category.id, category);
  for (const skill of [...library].sort((a, b) => (a.category ?? '').localeCompare(b.category ?? ''))) add(skill.category);
  for (const id of turnedOn) add(id);
  return [...groups.values()];
}

/** What Save and apply changes in what the tools can read, given the skills that will be on and those installed now. */
export function installChanges(
  skills: readonly CatalogSkill[],
  willBeOn: readonly string[],
  installed: readonly string[],
): { added: string[]; removed: string[] } {
  const on = new Set(willBeOn);
  const there = new Set(installed);
  // Only My library skills can be reported as removed. A workspace's own skill is stored in .agents/skills, so it stays,
  // and the others installed (analysis skills, tags) come from elsewhere.
  const managed = skills.filter(isLibrarySkill).map((skill) => skill.id);
  return {
    added: willBeOn.filter((id) => !there.has(id)),
    removed: managed.filter((id) => there.has(id) && !on.has(id)),
  };
}

/** What a skill is called by who loads it. The word "global" is not shown to users. */
export function skillOrigin(skill: Pick<SkillItem, 'source' | 'scope'>): string {
  if (skill.source) return `Built into ${skill.source.label || skill.source.harness}`;
  return skill.scope === 'workspace' ? 'This workspace only' : 'My library';
}

/** The skills a tool ships, grouped per tool, in the order tools first appear. */
export function builtInGroups(skills: readonly SkillItem[]): Array<{ harness: string; label: string; skills: SkillItem[] }> {
  const groups = new Map<string, { harness: string; label: string; skills: SkillItem[] }>();
  for (const skill of skills) {
    if (!skill.source) continue;
    const group = groups.get(skill.source.harness) ?? { harness: skill.source.harness, label: skill.source.label || skill.source.harness, skills: [] };
    group.skills.push(skill);
    groups.set(skill.source.harness, group);
  }
  return [...groups.values()];
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
