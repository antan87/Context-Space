/**
 * @module utils/harness-skill-quarantine
 * Takes a harness's global skill out of its folder (e.g. `~/.claude/skills/<id>`) and parks it in
 * ContextSpace's quarantine, so it stops loading everywhere. Nothing is deleted: the folder moves
 * with a manifest and can be restored. A harness sync can put a quarantined skill back.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';

import { resolveBrandHomeDir } from '../core/constants.js';
import { assertPathWithin } from '../resources/fs-safety.js';
import { findHarnessSkillDirs, type HarnessSkillDir } from './harness-skill-sources.js';

export const QUARANTINE_DIR_NAME = 'harness-skill-quarantine';
const MANIFEST_FILE = 'entry.json';
const MOVED_DIR = 'skill';

export interface QuarantineEntry {
  id: string;
  harness: string;
  label: string;
  /** Skills folder the skill came from, which the restore must stay inside. */
  root: string;
  /** Where the skill folder was before it was quarantined. */
  originalPath: string;
  quarantinedAt: string;
  /** Folder that holds the moved skill and its manifest. */
  entryDir: string;
}

export interface QuarantineOptions {
  /** Home directory to search. Defaults to the OS home, and to nothing in an isolated home. */
  homeDir?: string;
  /** Quarantine folder. Defaults to `<ContextSpace home>/harness-skill-quarantine`. */
  quarantineDir?: string;
  now?: Date;
}

function isolatedHomeIsSet(): boolean {
  return Boolean(process.env.CONTEXTSPACE_HOME?.trim() || process.env.NEXUSFLOW_HOME?.trim());
}

function resolveHomeDir(options: QuarantineOptions): string {
  if (options.homeDir) return options.homeDir;
  if (isolatedHomeIsSet()) {
    throw new Error('Harness skills are not visible in an isolated ContextSpace home, so they cannot be quarantined there.');
  }
  return os.homedir();
}

function resolveQuarantineDir(options: QuarantineOptions): string {
  return options.quarantineDir ?? path.join(resolveBrandHomeDir(), QUARANTINE_DIR_NAME);
}

function timestampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Moves the harness skill with this id out of its harness folder. When more than one harness
 * ships the id, the one the skills list shows (the first registered) is moved.
 */
export async function quarantineHarnessSkill(id: string, options: QuarantineOptions = {}): Promise<QuarantineEntry> {
  const homeDir = resolveHomeDir(options);
  const quarantineDir = resolveQuarantineDir(options);
  const now = options.now ?? new Date();

  const candidates = (await findHarnessSkillDirs(homeDir)).filter((found) => path.basename(found.skillDir) === id);
  const found: HarnessSkillDir | undefined = candidates[0];
  if (!found) throw new Error(`No harness skill named "${id}" was found.`);

  const stat = await fs.lstat(found.skillDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to quarantine "${id}": its folder is a link, not a plain folder.`);
  }
  assertPathWithin(found.root, found.skillDir);

  const entryDir = path.join(quarantineDir, found.harness, `${timestampFor(now)}-${id}`);
  const entry: QuarantineEntry = {
    id,
    harness: found.harness,
    label: found.label,
    root: found.root,
    originalPath: found.skillDir,
    quarantinedAt: now.toISOString(),
    entryDir,
  };
  await fse.ensureDir(entryDir);
  // The move comes first so a failure never leaves a manifest that points at a folder still in place.
  await fse.move(found.skillDir, path.join(entryDir, MOVED_DIR));
  await fse.writeJson(path.join(entryDir, MANIFEST_FILE), entry, { spaces: 2 });
  return entry;
}

/** Lists what is in quarantine, newest first. Entries whose manifest cannot be read are skipped. */
export async function listQuarantinedHarnessSkills(options: QuarantineOptions = {}): Promise<QuarantineEntry[]> {
  const quarantineDir = resolveQuarantineDir(options);
  const entries: QuarantineEntry[] = [];
  for (const harness of await fs.readdir(quarantineDir).catch(() => [] as string[])) {
    for (const dir of await fs.readdir(path.join(quarantineDir, harness)).catch(() => [] as string[])) {
      const entryDir = path.join(quarantineDir, harness, dir);
      const manifest = await fse.readJson(path.join(entryDir, MANIFEST_FILE)).catch(() => null);
      if (manifest && typeof manifest.id === 'string') entries.push({ ...manifest, entryDir });
    }
  }
  return entries.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
}

/**
 * Puts a quarantined skill back where it was. Refuses when something already sits at that path,
 * so a newer skill with the same name is never overwritten.
 */
export async function restoreHarnessSkill(id: string, options: QuarantineOptions = {}): Promise<QuarantineEntry> {
  const matches = (await listQuarantinedHarnessSkills(options)).filter((entry) => entry.id === id);
  const entry = matches[0];
  if (!entry) throw new Error(`No quarantined skill named "${id}" was found.`);

  assertPathWithin(entry.root, entry.originalPath);
  if (await fse.pathExists(entry.originalPath)) {
    throw new Error(`Cannot restore "${id}": ${entry.originalPath} already exists. Move or rename it first.`);
  }
  await fse.ensureDir(path.dirname(entry.originalPath));
  await fse.move(path.join(entry.entryDir, MOVED_DIR), entry.originalPath);
  await fse.remove(entry.entryDir);
  return entry;
}
