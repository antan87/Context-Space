/**
 * @module utils/harness-skill-sources
 * Where each CLI harness (Claude Code, Codex, ...) keeps the skills it loads globally, so the
 * skills list can show them next to the ContextSpace catalog.
 *
 * The folders are declared per harness in `src/harnesses/registry.ts` (`skills.globalRoots`),
 * so a new harness needs nothing here. See docs/adding-a-harness.md.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { HARNESSES, harnessSkillSources } from '../harnesses/registry.js';
import { isCliHarnessId, type CliHarnessId } from './cli-harnesses.js';

export interface HarnessSkillSource {
  /** Folders holding the harness's global skills. A leading `~/` is the home directory; absent folders are skipped. */
  roots: readonly string[];
  /**
   * How many folder levels below a root to search for `SKILL.md` (default 3).
   * A folder holding `SKILL.md` is a skill and is not searched further.
   */
  maxDepth?: number;
}

/**
 * Registry order is precedence: when two harnesses ship a skill with the same id, the first one listed is shown.
 * Skills in the ContextSpace catalog (`~/.contextspace/skills`) always win over these.
 */
export const HARNESS_SKILL_SOURCES: Record<CliHarnessId, HarnessSkillSource> = harnessSkillSources(HARNESSES);

export interface HarnessSkillDir {
  harness: string;
  /** Display name of the harness. */
  label: string;
  /** Symlink-resolved skills folder that was searched. */
  root: string;
  /** Absolute path of a folder that holds a `SKILL.md`. */
  skillDir: string;
}

const DEFAULT_MAX_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

function expandHome(root: string, homeDir: string): string {
  if (root === '~') return homeDir;
  if (root.startsWith('~/')) return path.join(homeDir, ...root.slice(2).split('/'));
  return root;
}

async function hasSkillFile(dir: string): Promise<boolean> {
  return fs.stat(path.join(dir, 'SKILL.md')).then((stat) => stat.isFile(), () => false);
}

/** Symlinked folders are not followed: a skill reached through one could point outside the harness's own folder. */
async function collectSkillDirs(dir: string, depth: number, maxDepth: number, found: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (await hasSkillFile(child)) found.push(child);
    else if (depth < maxDepth) await collectSkillDirs(child, depth + 1, maxDepth, found);
  }
}

/**
 * Finds the skill folders every harness keeps under `homeDir`, in registration order.
 * Roots that do not exist are skipped, and a root listed by two harnesses is searched once.
 */
export async function findHarnessSkillDirs(
  homeDir: string,
  sources: Readonly<Record<string, HarnessSkillSource>> = HARNESS_SKILL_SOURCES,
): Promise<HarnessSkillDir[]> {
  const result: HarnessSkillDir[] = [];
  const searchedRoots = new Set<string>();
  for (const [harness, source] of Object.entries(sources)) {
    const label = isCliHarnessId(harness) ? HARNESSES[harness].name : harness;
    for (const configured of source.roots) {
      // A root may itself be a symlink (dotfile managers do this), so resolve it once and treat the result as the root.
      const root = await fs.realpath(expandHome(configured, homeDir)).catch(() => null);
      if (!root || searchedRoots.has(root)) continue;
      searchedRoots.add(root);
      const skillDirs: string[] = [];
      await collectSkillDirs(root, 1, source.maxDepth ?? DEFAULT_MAX_DEPTH, skillDirs);
      for (const skillDir of skillDirs) result.push({ harness, label, root, skillDir });
    }
  }
  return result;
}
