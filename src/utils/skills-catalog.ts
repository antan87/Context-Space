/**
 * @module utils/skills-catalog
 * Manages built-in template categories, user-defined custom categories,
 * portable skills packages (SKILL.md), and workspace skills assignments.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import fse from 'fs-extra';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

import { slugify } from './slug.js';
import { findHarnessSkillDirs } from './harness-skill-sources.js';
import { LOCAL_SKILLS_FOLDER, SKILL_FOLDER_ADAPTERS, workspaceSkillFolders } from '../harnesses/registry.js';
import { acquireLock, createMutationQueue } from '../core/locks.js';
import {
  resolveBrandHomeDir,
  resolveGlobalDurablePath,
  resolveWorkspaceConfigDir,
  PRIMARY_CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  RESOURCE_LOCKS_DIR,
  RESOURCE_CATALOG_LOCK_FILE,
  RESOURCE_METADATA_KEY,
  LEGACY_RESOURCE_METADATA_KEY,
  STORE_CATEGORIES_FILE,
  RESOURCE_SKILLS_DIR,
} from '../core/constants.js';
import {
  formatValidationError,
  resourceIdSchema,
  skillCategorySchema,
  skillFrontmatterSchema,
  workspaceResourcesConfigSchema,
} from '../resources/contracts.js';
import {
  assertNoLinkedPathComponents,
  assertPathWithin,
  assertPathIsNotLink,
  atomicWriteJson,
} from '../resources/fs-safety.js';
import type {
  SaveSkillOptions,
  SkillCategory,
  SkillItem,
  SkillParameter,
  WorkspaceSkillsConfig,
} from '../types.js';

export type {
  SaveSkillOptions,
  SkillCategory,
  SkillItem,
  SkillParameter,
  WorkspaceSkillsConfig,
};

// ─── Frontmatter Helper ───────────────────────────────────────────────────

export interface ParsedFrontmatter {
  name?: string;
  title?: string;
  category?: string;
  description?: string;
  tags?: string[];
  'allowed-tools'?: string[];
  allowedTools?: string[];
  parameters?: SkillParameter[];
  model?: string;
  'permission-mode'?: 'plan' | 'default' | 'strict';
  permissionMode?: 'plan' | 'default' | 'strict';
  [key: string]: unknown;
}

/**
 * Parses YAML frontmatter delimited by `---`, handling CRLF line endings and UTF-8 BOM.
 */
export function parseSkillMarkdown(raw: string): { metadata: ParsedFrontmatter; content: string } {
  // Strip UTF-8 BOM and normalize CRLF to LF
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith('---')) {
    return { metadata: {}, content: raw };
  }

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { metadata: {}, content: raw };
  }

  const yamlBlock = normalized.substring(3, endIndex).trim();
  const content = normalized.substring(endIndex + 4).trim();
  let metadata: ParsedFrontmatter = {};

  try {
    const loaded = yamlLoad(yamlBlock);
    if (loaded && typeof loaded === 'object') {
      metadata = loaded as ParsedFrontmatter;
    }
  } catch (err) {
    console.error('Failed to parse YAML frontmatter:', err);
  }

  return { metadata, content };
}

/**
 * Serializes metadata and content into YAML frontmatter markdown.
 */
export function serializeSkillMarkdown(
  metadata: Record<string, unknown>,
  content: string,
): string {
  const cleanMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== undefined && v !== null && v !== '') {
      cleanMeta[k] = v;
    }
  }

  const yamlString = yamlDump(cleanMeta, { lineWidth: -1 }).trim();
  return `---\n${yamlString}\n---\n\n${content.trim()}\n`;

}


// ─── Security Helpers ─────────────────────────────────────────────────────

const runCatalogMutation = createMutationQueue();
const runWorkspaceConfigMutation = createMutationQueue();

export class WorkspaceResourceRevisionError extends Error {
  constructor(expected: number, current: number) {
    super(`Workspace resource configuration changed (expected revision ${expected}, current ${current}).`);
    this.name = 'WorkspaceResourceRevisionError';
  }
}

async function withCatalogLock<T>(operation: () => Promise<T>): Promise<T> {
  return runCatalogMutation(async () => {
    const release = await acquireLock(path.join(resolveBrandHomeDir(), RESOURCE_LOCKS_DIR, RESOURCE_CATALOG_LOCK_FILE), {
      staleMs: 60_000,
      timeoutMs: 10_000,
      timeoutMessage: 'Timed out waiting for the resource catalog lock.',
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

// ─── Default Template Categories & Skills ─────────────────────────────────

export const DEFAULT_CATEGORIES: SkillCategory[] = [];
export const DEFAULT_SKILLS: SkillItem[] = [];

// ─── Categories Management ────────────────────────────────────────────────

export function getContextSpaceHome(): string {
  return resolveBrandHomeDir();
}

export const getNexusFlowHome = getContextSpaceHome;


export function getUserCategoriesPath(): string {
  return resolveGlobalDurablePath(STORE_CATEGORIES_FILE);
}

export function getUserSkillsDir(): string {
  return resolveGlobalDurablePath(RESOURCE_SKILLS_DIR);
}

const PORTABLE_SKILL_SUPPORT_DIRECTORIES = new Set(['scripts', 'references', 'assets', 'agents']);

async function copySkillSupportTree(sourceDir: string, targetDir: string): Promise<void> {
  await fse.ensureDir(targetDir);
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Linked skill support files are not allowed: ${entry.name}`);
    }
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySkillSupportTree(source, target);
    } else if (entry.isFile()) {
      await fs.copyFile(source, target);
    } else {
      throw new Error(`Unsupported skill support entry: ${entry.name}`);
    }
  }
}

async function readUserSkillCategories(userPath: string): Promise<SkillCategory[]> {
  if (!(await fse.pathExists(userPath))) {
    return [];
  }

  const data: unknown = await fse.readJson(userPath);
  if (!Array.isArray(data)) {
    throw new Error('Custom skill categories must be stored as an array.');
  }

  const categories: SkillCategory[] = [];
  for (const item of data) {
    const parsed = skillCategorySchema.safeParse(item);
    if (!parsed.success) {
      console.warn(`Ignoring invalid custom skill category: ${formatValidationError(parsed.error)}`);
      continue;
    }
    categories.push(parsed.data);
  }
  return categories;
}


/**
 * Loads all skill categories (merging built-in templates and user custom categories).
 */
export async function getSkillCategories(): Promise<SkillCategory[]> {
  const categoryMap = new Map<string, SkillCategory>();

  // 1. Seed with default template categories
  for (const cat of DEFAULT_CATEGORIES) {
    categoryMap.set(cat.id, { ...cat });
  }

  // 2. Load user categories (legacy fallback then primary, or isolated custom home)
  const csHome = process.env.CONTEXTSPACE_HOME?.trim();
  const nfHome = process.env.NEXUSFLOW_HOME?.trim();
  const candidateFiles: string[] = (csHome || nfHome)
    ? [getUserCategoriesPath()]
    : [
        path.join(os.homedir(), LEGACY_CONFIG_DIR_NAME, 'categories.json'),
        path.join(os.homedir(), PRIMARY_CONFIG_DIR_NAME, 'categories.json'),
      ];
  const userPath = getUserCategoriesPath();
  if (!candidateFiles.includes(userPath)) {
    candidateFiles.push(userPath);
  }

  for (const filePath of candidateFiles) {
    try {
      if (await fse.pathExists(filePath)) {
        const data = await readUserSkillCategories(filePath);
        for (const item of data) {
          categoryMap.set(item.id, {
            ...item,
            custom: item.custom !== undefined ? item.custom : true,
            isTemplate: item.isTemplate !== undefined ? item.isTemplate : false,
          });
        }
      }
    } catch (err) {
      console.error('Failed to read user categories from', filePath, err);
    }
  }

  return Array.from(categoryMap.values());
}

/**
 * Saves or updates a custom skill category.
 */
export async function saveSkillCategory(
  category: Partial<SkillCategory> & { name: string },
): Promise<SkillCategory> {
  const rawId = category.id || slugify(category.name);
  const id = slugify(rawId);
  if (!id) {
    throw new Error('Category name cannot be empty');
  }

  return withCatalogLock(async () => {
    const userPath = getUserCategoriesPath();
    await fse.ensureDir(path.dirname(userPath));
    const userItems = await readUserSkillCategories(userPath);
    const existing = userItems.find((item) => item.id === id)
      ?? DEFAULT_CATEGORIES.find((item) => item.id === id);

    const candidate: SkillCategory = {
      id,
      name: category.name.trim(),
      description: category.description?.trim() || '',
      icon: category.icon || existing?.icon || 'folder',
      color: category.color || existing?.color || '#3b82f6',
      custom: true,
      isTemplate: existing?.isTemplate || false,
      skills: category.skills || existing?.skills || [],
    };
    const parsed = skillCategorySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Invalid skill category: ${formatValidationError(parsed.error)}`);
    }

    const filtered = userItems.filter((item) => item.id !== id);
    filtered.push(parsed.data);
    await atomicWriteJson(userPath, filtered);
    return parsed.data;
  });
}

/**
 * Deletes a custom skill category or resets a customized template override.
 */
export async function deleteSkillCategory(id: string): Promise<void> {
  const sanitizedId = slugify(id);
  if (!sanitizedId) {
    throw new Error('Invalid category ID');
  }

  await withCatalogLock(async () => {
    const userPath = getUserCategoriesPath();
    const userItems = await readUserSkillCategories(userPath);
    const isCustomized = userItems.some((item) => item.id === sanitizedId);
    const defaultTemplate = DEFAULT_CATEGORIES.find((item) => item.id === sanitizedId);

    if (!isCustomized && defaultTemplate) {
      throw new Error('Cannot delete built-in template categories');
    }

    if (!isCustomized && !defaultTemplate) {
      throw new Error('Category not found');
    }

    // Removing an override resets it back to the built-in category.
    const filtered = userItems.filter((item) => item.id !== sanitizedId);
    await atomicWriteJson(userPath, filtered);
  });
}

// ─── Skills Management ────────────────────────────────────────────────────

/**
 * Reads a skill package from a directory containing SKILL.md.
 */
async function loadSkillFromDir(
  skillDir: string,
  custom: boolean,
  catalogRoot = path.dirname(skillDir),
): Promise<SkillItem | null> {
  await assertNoLinkedPathComponents(catalogRoot, skillDir);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!(await fse.pathExists(skillFile))) {
    return null;
  }

  const raw = await fs.readFile(skillFile, 'utf-8');
  const { metadata, content } = parseSkillMarkdown(raw);
  const parsedMetadata = skillFrontmatterSchema.safeParse(metadata);
  if (!parsedMetadata.success) {
    throw new Error(`Invalid SKILL.md: ${formatValidationError(parsedMetadata.error)}`);
  }
  const id = parsedMetadata.data.name;
  const directoryId = path.basename(skillDir);
  if (id !== directoryId) {
    throw new Error(`Skill name "${id}" must match directory identity "${directoryId}". Rename the folder to "${id}", or change name: to "${directoryId}" in SKILL.md.`);
  }
  const name = id;
  const metadataObj = parsedMetadata.data.metadata as Record<string, unknown> | undefined;
  const brandMetadata =
    metadataObj &&
    typeof metadataObj[RESOURCE_METADATA_KEY] === 'object' &&
    metadataObj[RESOURCE_METADATA_KEY] !== null
      ? (metadataObj[RESOURCE_METADATA_KEY] as Record<string, unknown>)
      : metadataObj &&
        typeof metadataObj[LEGACY_RESOURCE_METADATA_KEY] === 'object' &&
        metadataObj[LEGACY_RESOURCE_METADATA_KEY] !== null
        ? (metadataObj[LEGACY_RESOURCE_METADATA_KEY] as Record<string, unknown>)
        : {};
  const rawMetaTitle = metadataObj && typeof metadataObj.title === 'string' ? metadataObj.title : undefined;
  const title =
    parsedMetadata.data.title ||
    (typeof brandMetadata.title === 'string' ? brandMetadata.title : undefined) ||
    rawMetaTitle ||
    name
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' ');
  const rawMetaCategory = metadataObj && typeof metadataObj.category === 'string' ? metadataObj.category : undefined;
  const namedCategory =
    parsedMetadata.data.category ||
    (typeof brandMetadata.category === 'string' ? brandMetadata.category : undefined) ||
    rawMetaCategory;
  const category = namedCategory || 'general';
  const description = parsedMetadata.data.description;
  const rawMetaTags =
    metadataObj && Array.isArray(metadataObj.tags)
      ? metadataObj.tags.filter((t): t is string => typeof t === 'string')
      : metadataObj && typeof metadataObj.tags === 'string'
        ? metadataObj.tags.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
  const tags =
    parsedMetadata.data.tags ||
    (Array.isArray(brandMetadata.tags)
      ? brandMetadata.tags.filter((tag): tag is string => typeof tag === 'string')
      : rawMetaTags);
  const rawAllowedTools = parsedMetadata.data['allowed-tools'];
  const allowedTools = Array.isArray(rawAllowedTools)
    ? rawAllowedTools
    : rawAllowedTools
      ? rawAllowedTools.split(/\s+/).filter(Boolean)
      : [];

  // Inspect references/, scripts/, and assets/ if present (per Agent Skills spec)
  const referencesDir = path.join(skillDir, 'references');
  const scriptsDir = path.join(skillDir, 'scripts');
  const assetsDir = path.join(skillDir, 'assets');

  const references: { name: string; relativePath: string }[] = [];
  const scripts: { name: string; relativePath: string }[] = [];
  const assets: { name: string; relativePath: string }[] = [];

  if (await fse.pathExists(referencesDir)) {
    try {
      await assertNoLinkedPathComponents(skillDir, referencesDir);
      const files = await fs.readdir(referencesDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isSymbolicLink()) throw new Error(`Linked skill files are not allowed: ${file.name}`);
        if (file.isFile()) {
          references.push({ name: file.name, relativePath: path.join('references', file.name) });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Linked skill files')) throw error;
    }
  }

  if (await fse.pathExists(scriptsDir)) {
    try {
      await assertNoLinkedPathComponents(skillDir, scriptsDir);
      const files = await fs.readdir(scriptsDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isSymbolicLink()) throw new Error(`Linked skill files are not allowed: ${file.name}`);
        if (file.isFile()) {
          scripts.push({ name: file.name, relativePath: path.join('scripts', file.name) });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Linked skill files')) throw error;
    }
  }

  if (await fse.pathExists(assetsDir)) {
    try {
      await assertNoLinkedPathComponents(skillDir, assetsDir);
      const files = await fs.readdir(assetsDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isSymbolicLink()) throw new Error(`Linked skill files are not allowed: ${file.name}`);
        if (file.isFile()) {
          assets.push({ name: file.name, relativePath: path.join('assets', file.name) });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Linked skill files')) throw error;
    }
  }

  const rawScope = parsedMetadata.data.scope ?? brandMetadata.scope;
  const scope: 'workspace' | 'global' | undefined =
    rawScope === 'workspace' || rawScope === 'global' ? rawScope : undefined;

  return {
    id,
    name,
    title,
    category,
    // Only set when it applies, so a skill that names its category is unchanged.
    ...(namedCategory ? {} : { categoryAssumed: true }),
    description,
    tags,
    allowedTools,
    content,
    rawFile: raw,
    custom,
    sourcePath: skillDir,
    references: references.length > 0 ? references : undefined,
    scripts: scripts.length > 0 ? scripts : undefined,
    assets: assets.length > 0 ? assets : undefined,
    scope,
    metadata: metadataObj,
    license: parsedMetadata.data.license,
    compatibility: parsedMetadata.data.compatibility,
  };
}

/**
 * Retrieves all available skills (built-in templates + user directory + optional workspace directory).
 */
export interface SkillDiagnostic {
  id: string;
  scope: 'global' | 'workspace';
  message: string;
  /** 'error': the skill was not loaded. 'warning': it loaded, but something is off. Absent means 'error'. */
  level?: 'error' | 'warning';
  /** Harness id when the skill belongs to a harness's own folder, which the user does not maintain here. */
  source?: string;
}

/** A skill that names no category loads fine but lands in 'general', where it looks missing. */
function categoryNotice(id: string, scope: SkillDiagnostic['scope']): SkillDiagnostic {
  return {
    id,
    scope,
    level: 'warning',
    message: 'No category is set in SKILL.md, so this skill is listed under "general". Add "category: <name>" to its frontmatter.',
  };
}

/**
 * Adds the skills each harness keeps in its own global folders (see `HARNESS_SKILL_SOURCES`).
 * They are listed read-only (`custom: false`, `source` set): the harness owns the files.
 * Problems are warnings, since the user cannot fix a harness's files from here.
 */
async function addHarnessSkills(
  skillMap: Map<string, SkillItem>,
  homeDir: string,
  diagnostics?: SkillDiagnostic[],
): Promise<void> {
  // A harness can ship one skill in several of its folders, so report each problem once.
  const reported = new Set<string>();
  for (const found of await findHarnessSkillDirs(homeDir)) {
    const source = { harness: found.harness, label: found.label, root: found.root };
    try {
      const loaded = await loadSkillFromDir(found.skillDir, false, found.root);
      if (!loaded) continue;
      const existing = skillMap.get(loaded.id);
      if (existing) {
        if (existing.source && existing.source.harness !== found.harness) {
          diagnostics?.push({
            id: loaded.id,
            scope: 'global',
            level: 'warning',
            source: found.harness,
            message: `${found.label} also provides this skill (${found.skillDir}). Showing the ${existing.source.label} copy.`,
          });
        }
        continue;
      }
      // The user cannot add a category to a harness's file, so do not flag it as missing.
      skillMap.set(loaded.id, { ...loaded, categoryAssumed: undefined, scope: 'global', source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = `${found.harness}\0${path.basename(found.skillDir)}\0${message}`;
      if (reported.has(key)) continue;
      reported.add(key);
      diagnostics?.push({
        id: path.basename(found.skillDir),
        scope: 'global',
        level: 'warning',
        source: found.harness,
        message: `${found.label}: ${message}`,
      });
    }
  }
}

export async function getAllSkills(
  workspacePath?: string,
  diagnostics?: SkillDiagnostic[],
  options: { harnessHomeDir?: string } = {},
): Promise<SkillItem[]> {
  const skillMap = new Map<string, SkillItem>();
  const csHome = process.env.CONTEXTSPACE_HOME?.trim();
  const nfHome = process.env.NEXUSFLOW_HOME?.trim();

  // 1. Built-in template skills
  for (const s of DEFAULT_SKILLS) {
    skillMap.set(s.id, { ...s, scope: 'global' });
  }

  // 2. Skills the harnesses load from their own global folders (~/.claude/skills, ~/.codex/skills, ...).
  // Read first so the ContextSpace catalog below wins an id clash. An isolated custom home skips them
  // (like the user directory below), unless the caller names a home.
  const harnessHomeDir = options.harnessHomeDir ?? (csHome || nfHome ? undefined : os.homedir());
  if (harnessHomeDir) await addHarnessSkills(skillMap, harnessHomeDir, diagnostics);

  // 3. User directory (~/.nexusflow/skills/ and ~/.contextspace/skills/, or isolated custom home)
  const candidateDirs: string[] = (csHome || nfHome)
    ? [getUserSkillsDir()]
    : [
        path.join(os.homedir(), LEGACY_CONFIG_DIR_NAME, 'skills'),
        path.join(os.homedir(), PRIMARY_CONFIG_DIR_NAME, 'skills'),
      ];
  const activeSkillsDir = getUserSkillsDir();
  if (!candidateDirs.includes(activeSkillsDir)) {
    candidateDirs.push(activeSkillsDir);
  }

  for (const userSkillsDir of candidateDirs) {
    if (await fse.pathExists(userSkillsDir)) {
      try {
        await assertPathIsNotLink(userSkillsDir);
        const entries = await fs.readdir(userSkillsDir, { withFileTypes: true });
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const isDir = typeof entry === 'string' ? true : entry.isDirectory ? entry.isDirectory() : true;
            const entryName = typeof entry === 'string' ? entry : entry.name;
            if (isDir) {
              try {
                const loaded = await loadSkillFromDir(path.join(userSkillsDir, entryName), true, userSkillsDir);
                if (loaded) {
                  const isBuiltIn = DEFAULT_SKILLS.some((s) => s.id === loaded.id);
                  if (isBuiltIn) {
                    throw new Error(`A resource named "${loaded.id}" already exists in the built-in catalog.`);
                  }
                  loaded.scope = loaded.scope || 'global';
                  skillMap.set(loaded.id, loaded);
                  if (loaded.categoryAssumed) diagnostics?.push(categoryNotice(loaded.id, 'global'));
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                diagnostics?.push({ id: entryName, scope: 'global', message, level: 'error' });
                console.warn(`Skipping invalid skill "${entryName}": ${message}`);
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to load user skills from', userSkillsDir, err);
      }
    }
  }

  // 4. Workspace-local skills (<workspace>/.agents/skills/)
  if (workspacePath) {
    try {
      const canonicalWorkspace = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
      const workspaceSkillsDir = path.join(canonicalWorkspace, ...LOCAL_SKILLS_FOLDER.split('/'));
      if (await fse.pathExists(workspaceSkillsDir)) {
        await assertPathIsNotLink(workspaceSkillsDir);

        const materializedGlobalSkillIds = new Set<string>();
        const lockPathPrimary = path.join(canonicalWorkspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json');
        const lockPathLegacy = path.join(canonicalWorkspace, LEGACY_CONFIG_DIR_NAME, 'resources.lock.json');
        const lockPath = (await fse.pathExists(lockPathPrimary))
          ? lockPathPrimary
          : (await fse.pathExists(lockPathLegacy))
            ? lockPathLegacy
            : null;

        if (lockPath) {
          try {
            const lockJson = await fse.readJson(lockPath);
            const outputs = Array.isArray(lockJson?.outputs)
              ? lockJson.outputs
              : Array.isArray(lockJson?.managedFiles)
                ? lockJson.managedFiles
                : [];
            for (const out of outputs) {
              if (out && out.kind === 'skill') {
                const outPath = typeof out.path === 'string' ? out.path.replaceAll('\\', '/') : '';
                if (out.adapter === SKILL_FOLDER_ADAPTERS[LOCAL_SKILLS_FOLDER] || outPath.startsWith(`${LOCAL_SKILLS_FOLDER}/`)) {
                  if (typeof out.resourceId === 'string') {
                    materializedGlobalSkillIds.add(out.resourceId);
                  }
                }
              }
            }
          } catch {
            // Ignore unreadable or corrupt lock file
          }
        }

        const entries = await fs.readdir(workspaceSkillsDir, { withFileTypes: true });
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const isDir = typeof entry === 'string' ? true : entry.isDirectory ? entry.isDirectory() : true;
            const entryName = typeof entry === 'string' ? entry : entry.name;
            if (isDir) {
              try {
                const skillDir = path.join(workspaceSkillsDir, entryName);
                const loaded = await loadSkillFromDir(skillDir, true, workspaceSkillsDir);
                if (loaded) {
                  const isMaterializedGlobal =
                    loaded.scope === 'global' ||
                    (loaded.scope !== 'workspace' && materializedGlobalSkillIds.has(loaded.id));

                  if (isMaterializedGlobal) {
                    // Materialized global skill: do NOT mark its scope as 'workspace'.
                    // If its global counterpart was deleted machine-wide, do NOT resurrect it as an active workspace skill.
                    if (skillMap.has(loaded.id)) {
                      const globalSkill = skillMap.get(loaded.id)!;
                      globalSkill.scope = 'global';
                    } else {
                      diagnostics?.push({ id: loaded.id, scope: 'workspace', level: 'error', message: 'This copy declares global scope or was generated from a global skill, but that catalog source is missing. Restore the source or explicitly convert the package to workspace scope.' });
                    }
                  } else {
                    if (skillMap.has(loaded.id)) diagnostics?.push({ id: loaded.id, scope: 'workspace', level: 'warning', message: 'The workspace package overrides a global skill with the same ID. Rename it to keep both independently selectable.' });
                    loaded.scope = 'workspace';
                    skillMap.set(loaded.id, loaded);
                    if (loaded.categoryAssumed) diagnostics?.push(categoryNotice(loaded.id, 'workspace'));
                  }
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                diagnostics?.push({ id: entryName, scope: 'workspace', message, level: 'error' });
                console.warn(`Skipping invalid workspace skill "${entryName}": ${message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to load workspace skills from', workspacePath, err);
    }
  }

  return Array.from(skillMap.values());
}

/**
 * Saves or updates a portable skill package.
 */
export async function saveSkill(
  skill: Partial<SkillItem> & { name: string; content: string },
  options: SaveSkillOptions = {},
): Promise<SkillItem & { path: string; skill: SkillItem }> {
  const scope = options.scope ?? 'global';
  if (scope === 'workspace' && !options.workspacePath) {
    throw new Error('workspacePath is required when saving a workspace-scoped skill.');
  }

  const rawId = skill.id || skill.name;
  const idResult = resourceIdSchema.safeParse(rawId);
  if (!idResult.success) {
    throw new Error(`Invalid skill ID: ${formatValidationError(idResult.error)}`);
  }
  if (idResult.data !== rawId) throw new Error('Invalid skill ID format.');
  const id = idResult.data;
  const nameResult = resourceIdSchema.safeParse(skill.name);
  if (!nameResult.success || nameResult.data !== skill.name || nameResult.data !== id) {
    throw new Error('Skill id and name must match.');
  }
  if (DEFAULT_SKILLS.some((builtIn) => builtIn.id === id)) {
    throw new Error('Built-in skills cannot be overwritten. Create a custom skill with a new identifier.');
  }
  const description = skill.description?.trim();
  if (!description) throw new Error('Skill description is required.');
  if (!skill.content.trim()) throw new Error('Skill content is required.');

  const executeSave = async (skillsBaseDir: string) => {
    await fse.ensureDir(skillsBaseDir);
    await assertPathIsNotLink(skillsBaseDir);
    const targetDir = assertPathWithin(skillsBaseDir, path.join(skillsBaseDir, id));
    await assertNoLinkedPathComponents(skillsBaseDir, targetDir);

    const stagingDir = await fs.mkdtemp(path.join(skillsBaseDir, `.staging-${id}-`));
    const backupDir = path.join(skillsBaseDir, `.backup-${id}-${randomUUID()}`);
    let movedExisting = false;
    let installedStaging = false;
    try {
      let existingFrontmatter: ReturnType<typeof skillFrontmatterSchema.parse> | undefined;
      if (await fse.pathExists(targetDir)) {
        await assertNoLinkedPathComponents(skillsBaseDir, targetDir);
        for (const entry of await fs.readdir(targetDir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) {
            throw new Error(`Linked skill package entries are not allowed: ${entry.name}`);
          }
          if (entry.name === 'SKILL.md') continue;
          if (!entry.isDirectory() || !PORTABLE_SKILL_SUPPORT_DIRECTORIES.has(entry.name)) {
            throw new Error(`Unsupported top-level skill package entry: ${entry.name}`);
          }
          await copySkillSupportTree(path.join(targetDir, entry.name), path.join(stagingDir, entry.name));
        }
        const currentSkillMarkdown = parseSkillMarkdown(
          await fs.readFile(path.join(targetDir, 'SKILL.md'), 'utf-8'),
        );
        const parsedCurrentFrontmatter = skillFrontmatterSchema.safeParse(currentSkillMarkdown.metadata);
        if (parsedCurrentFrontmatter.success) existingFrontmatter = parsedCurrentFrontmatter.data;
      }

      const existingMetaObj = existingFrontmatter?.metadata;
      const callerMetadata =
        skill.metadata && typeof skill.metadata === 'object' && !Array.isArray(skill.metadata)
          ? (skill.metadata as Record<string, unknown>)
          : undefined;
      const existingBrandMetadata =
        existingMetaObj &&
        typeof existingMetaObj[RESOURCE_METADATA_KEY] === 'object' &&
        existingMetaObj[RESOURCE_METADATA_KEY] !== null
          ? (existingMetaObj[RESOURCE_METADATA_KEY] as Record<string, unknown>)
          : existingMetaObj &&
            typeof existingMetaObj[LEGACY_RESOURCE_METADATA_KEY] === 'object' &&
            existingMetaObj[LEGACY_RESOURCE_METADATA_KEY] !== null
            ? (existingMetaObj[LEGACY_RESOURCE_METADATA_KEY] as Record<string, unknown>)
            : {};
      const callerBrandMetadata =
        callerMetadata &&
        typeof callerMetadata[RESOURCE_METADATA_KEY] === 'object' &&
        callerMetadata[RESOURCE_METADATA_KEY] !== null
          ? (callerMetadata[RESOURCE_METADATA_KEY] as Record<string, unknown>)
          : callerMetadata &&
            typeof callerMetadata[LEGACY_RESOURCE_METADATA_KEY] === 'object' &&
            callerMetadata[LEGACY_RESOURCE_METADATA_KEY] !== null
            ? (callerMetadata[LEGACY_RESOURCE_METADATA_KEY] as Record<string, unknown>)
            : {};
      const inferredTitle =
        skill.title ||
        (callerMetadata && typeof callerMetadata.title === 'string' ? callerMetadata.title : undefined) ||
        (typeof existingBrandMetadata.title === 'string' ? existingBrandMetadata.title : undefined) ||
        id;
      const inferredCategory =
        options.category ||
        skill.category ||
        (callerMetadata && typeof callerMetadata.category === 'string' ? callerMetadata.category : undefined) ||
        (typeof existingBrandMetadata.category === 'string' ? existingBrandMetadata.category : undefined) ||
        'general';
      const callerMetaTags =
        callerMetadata && Array.isArray(callerMetadata.tags)
          ? callerMetadata.tags.filter((t): t is string => typeof t === 'string')
          : undefined;
      const existingBrandTags =
        Array.isArray(existingBrandMetadata.tags)
          ? existingBrandMetadata.tags.filter((t): t is string => typeof t === 'string')
          : undefined;
      const inferredTags = skill.tags || callerMetaTags || existingBrandTags || [];

      const metadataPayload = {
        ...existingBrandMetadata,
        ...callerBrandMetadata,
        title: inferredTitle,
        category: inferredCategory,
        tags: inferredTags,
        scope,
      };
      const mergedCustomMetadata: Record<string, unknown> = {
        ...(existingFrontmatter?.metadata ?? {}),
        ...(callerMetadata ?? {}),
      };
      delete mergedCustomMetadata[RESOURCE_METADATA_KEY];
      delete mergedCustomMetadata[LEGACY_RESOURCE_METADATA_KEY];
      delete mergedCustomMetadata['__proto__'];
      delete mergedCustomMetadata['constructor'];
      delete mergedCustomMetadata['prototype'];

      const metadata: Record<string, unknown> = {
        name: id,
        title: inferredTitle,
        category: inferredCategory,
        description,
        tags: inferredTags,
        license: skill.license ?? existingFrontmatter?.license,
        compatibility: skill.compatibility ?? existingFrontmatter?.compatibility,
        scope,
        metadata: {
          ...mergedCustomMetadata,
          [RESOURCE_METADATA_KEY]: metadataPayload,
          [LEGACY_RESOURCE_METADATA_KEY]: metadataPayload,
        },
      };
      const allowedTools = skill.allowedTools === undefined
        ? existingFrontmatter?.['allowed-tools']
        : skill.allowedTools;
      if (allowedTools?.length) metadata['allowed-tools'] = allowedTools;
      await fs.writeFile(
        path.join(stagingDir, 'SKILL.md'),
        serializeSkillMarkdown(metadata, skill.content),
        'utf-8',
      );

      for (const [directory, files] of [
        ['references', skill.references],
        ['scripts', skill.scripts],
        ['assets', skill.assets],
      ] as const) {
        if (files === undefined) continue;
        const supportDir = path.join(stagingDir, directory);
        await fse.remove(supportDir);
        if (!files.length) continue;
        await fse.ensureDir(supportDir);
        for (const file of files) {
          if (!file.name || path.basename(file.name) !== file.name || file.content === undefined) {
            throw new Error(`Invalid ${directory} file name: ${file.name || '(empty)'}`);
          }
          const supportPath = path.join(supportDir, file.name);
          await fs.writeFile(supportPath, file.content, 'utf-8');
          const relativePath = `${directory}/${file.name}`;
          const mode = options.supportFileModes?.[relativePath];
          if (mode !== undefined) {
            try {
              await fs.chmod(supportPath, mode);
            } catch (error) {
              if (process.platform !== 'win32') throw error;
            }
          }
        }
      }

      await options.beforeCommit?.();

      if (await fse.pathExists(targetDir)) {
        await assertNoLinkedPathComponents(skillsBaseDir, targetDir);
        await fs.rename(targetDir, backupDir);
        movedExisting = true;
      }
      await fs.rename(stagingDir, targetDir);
      installedStaging = true;
      const loaded = await loadSkillFromDir(targetDir, true, skillsBaseDir);
      if (!loaded) throw new Error('Saved skill could not be loaded.');
      loaded.scope = scope;
      if (movedExisting) await fse.remove(backupDir).catch(() => {});
      const skillFilePath = path.join(targetDir, 'SKILL.md');
      return {
        ...loaded,
        path: skillFilePath,
        skill: loaded,
      };
    } catch (error) {
      await fse.remove(stagingDir).catch(() => {});
      if (installedStaging) await fse.remove(targetDir).catch(() => {});
      if (movedExisting && (await fse.pathExists(backupDir))) {
        await fs.rename(backupDir, targetDir).catch(() => {});
      }
      throw error;
    }
  };

  if (scope === 'workspace') {
    const canonicalWorkspace = await fs.realpath(options.workspacePath!).catch(() => path.resolve(options.workspacePath!));
    const workspaceSkillsDir = path.join(canonicalWorkspace, ...LOCAL_SKILLS_FOLDER.split('/'));
    return runWorkspaceConfigMutation(async () => {
      await assertNoLinkedPathComponents(canonicalWorkspace, workspaceSkillsDir);
      return executeSave(workspaceSkillsDir);
    });
  }

  return withCatalogLock(async () => executeSave(path.resolve(getUserSkillsDir())));
}

/**
 * Deletes a skill safely from the global or workspace catalog.
 */
export async function deleteSkill(
  id: string,
  options?: { scope?: 'workspace' | 'global'; workspacePath?: string },
): Promise<void> {
  const idResult = resourceIdSchema.safeParse(id);
  if (!idResult.success || idResult.data !== id) {
    throw new Error('Invalid skill ID format.');
  }

  const scope = options?.scope ?? 'global';
  if (scope === 'workspace') {
    if (!options?.workspacePath) {
      throw new Error('workspacePath is required when deleting a workspace-scoped skill.');
    }
    const wsPath = options.workspacePath;
    const canonicalWorkspace = await fs.realpath(wsPath).catch(() => path.resolve(wsPath));
    const workspaceSkillsDir = path.join(canonicalWorkspace, ...LOCAL_SKILLS_FOLDER.split('/'));
    await runWorkspaceConfigMutation(async () => {
      const targetDir = assertPathWithin(canonicalWorkspace, path.join(workspaceSkillsDir, id));
      await assertNoLinkedPathComponents(canonicalWorkspace, targetDir);
      if (!(await fse.pathExists(targetDir))) throw new Error('Skill not found.');
      await fse.remove(targetDir);
    });
    return;
  }

  await withCatalogLock(async () => {
    const userSkillsDir = path.resolve(getUserSkillsDir());
    await fse.ensureDir(userSkillsDir);
    await assertPathIsNotLink(userSkillsDir);
    const targetDir = assertPathWithin(userSkillsDir, path.join(userSkillsDir, id));
    if (!(await fse.pathExists(targetDir))) throw new Error('Skill not found.');
    await assertNoLinkedPathComponents(userSkillsDir, targetDir);
    await fse.remove(targetDir);
  });
}

// ─── Skills Harnesses Ship ────────────────────────────────────────────────

/** Why a harness skill could not be added to My library. */
export class SkillImportError extends Error {
  constructor(
    public readonly code: 'not-found' | 'exists',
    message: string,
  ) {
    super(message);
    this.name = 'SkillImportError';
  }
}

/**
 * Copies SKILL.md and the support folders a managed skill may hold. Anything else in a harness's folder (a
 * LICENSE, say) stays behind: a workspace copy rejects it. Links are never followed.
 */
async function copyPortableSkill(sourceDir: string, targetDir: string): Promise<void> {
  await fse.ensureDir(targetDir);
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    const isSupportDirectory = PORTABLE_SKILL_SUPPORT_DIRECTORIES.has(entry.name);
    if (entry.name !== 'SKILL.md' && !isSupportDirectory) continue;
    if (entry.isSymbolicLink()) throw new Error(`Linked skill files are not allowed: ${entry.name}`);
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') await fs.copyFile(source, target);
    else if (entry.isDirectory() && isSupportDirectory) await copySkillSupportTree(source, target);
  }
}

/**
 * Adds a copy of a skill a harness ships to My library, so it can be turned on in a workspace for every tool.
 * The harness keeps its own copy, which it loads whatever the library holds.
 *
 * @throws SkillImportError `exists` when the library already has a skill with this id, `not-found` when the harness has none.
 */
export async function importHarnessSkill(
  harness: string,
  id: string,
  options: { harnessHomeDir?: string } = {},
): Promise<SkillItem> {
  return withCatalogLock(async () => {
    const skills = await getAllSkills(undefined, undefined, options);
    if (skills.some((skill) => skill.id === id && !skill.source)) {
      throw new SkillImportError('exists', `My library already has a skill named "${id}".`);
    }
    const found = skills.find((skill) => skill.id === id && skill.source?.harness === harness);
    if (!found?.sourcePath) {
      throw new SkillImportError('not-found', `No skill named "${id}" is built into ${harness}.`);
    }

    const skillsBaseDir = path.resolve(getUserSkillsDir());
    await fse.ensureDir(skillsBaseDir);
    await assertPathIsNotLink(skillsBaseDir);
    const targetDir = assertPathWithin(skillsBaseDir, path.join(skillsBaseDir, found.id));
    // A folder that is there but does not load is not in the list above; still do not write over it.
    if (await fse.pathExists(targetDir)) {
      throw new SkillImportError('exists', `My library already has a skill named "${id}".`);
    }

    const stagingDir = await fs.mkdtemp(path.join(skillsBaseDir, `.staging-${found.id}-`));
    try {
      await copyPortableSkill(found.sourcePath, stagingDir);
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      await fse.remove(stagingDir).catch(() => {});
      throw error;
    }
    try {
      const loaded = await loadSkillFromDir(targetDir, true, skillsBaseDir);
      if (!loaded) throw new Error('Imported skill could not be loaded.');
      loaded.scope = 'global';
      return loaded;
    } catch (error) {
      await fse.remove(targetDir).catch(() => {});
      throw error;
    }
  });
}

// ─── Workspace Skills Assignment Config ────────────────────────────────────

/**
 * Loads workspace skills assignment config from `.nexusflow/skills.json` or returns defaults.
 */
export async function getWorkspaceSkillsConfig(workspacePath: string): Promise<WorkspaceSkillsConfig> {
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const primaryConfigFile = path.join(canonicalWorkspace, PRIMARY_CONFIG_DIR_NAME, 'skills.json');
  const legacyConfigFile = path.join(canonicalWorkspace, LEGACY_CONFIG_DIR_NAME, 'skills.json');
  const configFile = (await fse.pathExists(primaryConfigFile))
    ? primaryConfigFile
    : (await fse.pathExists(legacyConfigFile))
      ? legacyConfigFile
      : primaryConfigFile;
  if (await fse.pathExists(configFile)) {
    await assertNoLinkedPathComponents(canonicalWorkspace, configFile);
    const rawData = await fse.readJson(configFile) as unknown;
    const legacyData =
      typeof rawData === 'object' && rawData !== null && !('schemaVersion' in rawData)
        ? { schemaVersion: 1, revision: 0, ...rawData }
        : rawData;
    const result = workspaceResourcesConfigSchema.safeParse(legacyData);
    if (!result.success) {
      throw new Error(`Invalid workspace resource configuration: ${formatValidationError(result.error)}`);
    }
    // A version 1 file lists every category the old app registered, not categories anyone subscribed to.
    return result.data.schemaVersion === 1 ? { ...result.data, enabledCategories: [] } : result.data;
  }

  return {
    schemaVersion: 2,
    revision: 0,
    enabledSkills: [],
    disabledSkills: [],
    enabledAgents: [],
    enabledCategories: [],
  };
}

/**
 * Ids that have a SKILL.md in any folder a harness reads skills from in a workspace (`.agents/skills/<id>`,
 * `.claude/skills/<id>`) right now, whoever put it there.
 */
export async function listInstalledSkillIds(workspacePath: string): Promise<string[]> {
  const installed = new Set<string>();
  for (const folder of workspaceSkillFolders()) {
    const skillsDir = path.join(workspacePath, ...folder.split('/'));
    const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const hasSkillFile = await fs.stat(path.join(skillsDir, entry.name, 'SKILL.md')).then((stat) => stat.isFile(), () => false);
      if (hasSkillFile) installed.add(entry.name);
    }
  }
  return [...installed].sort();
}

/**
 * Saves workspace skills assignment config.
 */
export async function saveWorkspaceSkillsConfig(
  workspacePath: string,
  config: WorkspaceSkillsConfig,
  expectedRevision?: number,
): Promise<WorkspaceSkillsConfig> {
  return runWorkspaceConfigMutation(async () => {
    const canonicalWorkspace = await fs.realpath(workspacePath);
    const configDirInfo = resolveWorkspaceConfigDir(canonicalWorkspace);
    const configDir = configDirInfo.path;
    await fse.ensureDir(configDir);
    await assertNoLinkedPathComponents(canonicalWorkspace, configDir);
    await assertPathIsNotLink(configDir);

    const release = await acquireLock(path.join(configDir, 'resource-config.lock'), {
      staleMs: 60_000,
      timeoutMs: 10_000,
      timeoutMessage: 'Timed out waiting for the workspace resource configuration lock.',
    });
    try {
      const current = await getWorkspaceSkillsConfig(canonicalWorkspace);
      const currentRevision = current.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new WorkspaceResourceRevisionError(expectedRevision, currentRevision);
      }
      const parsed = workspaceResourcesConfigSchema.safeParse({
        schemaVersion: 2,
        revision: currentRevision + 1,
        enabledSkills: config.enabledSkills,
        disabledSkills: config.disabledSkills ?? current.disabledSkills ?? [],
        enabledAgents: config.enabledAgents ?? current.enabledAgents ?? [],
        enabledCategories: config.enabledCategories ?? [],
      });
      if (!parsed.success) {
        throw new Error(`Invalid workspace resource configuration: ${formatValidationError(parsed.error)}`);
      }
      await atomicWriteJson(path.join(configDir, 'skills.json'), parsed.data);
      return parsed.data;
    } finally {
      await release();
    }
  });
}
