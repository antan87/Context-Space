/**
 * @module resources/selection
 * Which skills a workspace gets. One rule, shared by refresh, the freshness check and the skills API, so
 * they cannot disagree. Pure: callers read the config and the catalog and pass them in.
 */

import type { SkillItem, WorkspaceSkillsConfig } from '../types.js';

/** The parts of a workspace's skills config that decide which skills it gets. */
export type SkillSelection = Pick<WorkspaceSkillsConfig, 'enabledSkills' | 'disabledSkills' | 'enabledCategories'>;

export interface SkillExtras {
  /**
   * Skills built from this workspace's analysis. A selected id finds them, but no category brings them in.
   * One with the same id as a catalog skill replaces it.
   */
  generated?: readonly SkillItem[];
  /** Ids switched on without being picked (analysis skills, workspace-only skills, domain packs). An unknown id is ignored. */
  ids?: readonly string[];
}

export interface ResolvedSkills {
  /** The skills to install, one per id. */
  skills: SkillItem[];
  /** Picked ids that are not in the library. */
  missing: string[];
  /** Picked ids a harness ships itself. It loads them everywhere, so they are never copied into a workspace. */
  builtIn: string[];
}

/**
 * A workspace's skills are every library or workspace skill in a subscribed category (now and later), plus
 * every single pick, minus every exception, plus the extras. A skill a harness owns (`source` set) is never
 * included, even when an old config lists it. A category is the skill's own `category`: nothing else puts a
 * skill in one.
 */
export function resolveWorkspaceSkills(
  config: SkillSelection,
  catalogSkills: readonly SkillItem[],
  extras: SkillExtras = {},
): ResolvedSkills {
  const byId = new Map<string, SkillItem>();
  for (const skill of catalogSkills) byId.set(skill.id, skill);
  for (const skill of extras.generated ?? []) byId.set(skill.id, skill);

  const exceptions = new Set(config.disabledSkills ?? []);
  const categories = new Set(config.enabledCategories ?? []);
  const selected = new Set<string>();
  const missing = new Set<string>();
  const builtIn = new Set<string>();

  for (const id of config.enabledSkills) {
    if (exceptions.has(id)) continue;
    const skill = byId.get(id);
    if (!skill) missing.add(id);
    else if (skill.source) builtIn.add(id);
    else selected.add(id);
  }
  for (const skill of catalogSkills) {
    if (!skill.source && categories.has(skill.category)) selected.add(skill.id);
  }
  for (const id of extras.ids ?? []) {
    const skill = byId.get(id);
    if (skill && !skill.source) selected.add(id);
  }
  for (const id of exceptions) selected.delete(id);

  return {
    skills: [...selected].map((id) => byId.get(id)!),
    missing: [...missing],
    builtIn: [...builtIn],
  };
}

/** A workspace nobody has saved a selection for yet. It also gets the skills written inside it. */
export function isDefaultSkillsConfig(config: Pick<WorkspaceSkillsConfig, 'revision' | 'disabledSkills'>): boolean {
  return (config.revision ?? 0) === 0 && (config.disabledSkills?.length ?? 0) === 0;
}

/** Skills written inside the workspace that it gets without anyone picking them: only on a default config. */
export function workspaceOnlySkillIds(
  config: Pick<WorkspaceSkillsConfig, 'revision' | 'disabledSkills'>,
  catalogSkills: readonly SkillItem[],
): string[] {
  if (!isDefaultSkillsConfig(config)) return [];
  return catalogSkills.filter((skill) => skill.scope === 'workspace' && !skill.source).map((skill) => skill.id);
}
