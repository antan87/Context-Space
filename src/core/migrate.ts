/**
 * @module core/migrate
 * Systematic migration of legacy NexusFlow workspaces and global configurations to ContextSpace.
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BRAND_CONFIG } from './brand-config.js';
import { loadFeatureConfig } from './workspace.js';
import { refreshWorkspace } from './refresh.js';

export interface FileMigrationResult {
  from: string;
  to: string;
  status: 'renamed' | 'copied' | 'skipped' | 'failed';
  error?: string;
}

export interface WorkspaceMigrationReport {
  workspacePath: string;
  featureId: string;
  isLegacy: boolean;
  renamedFiles: FileMigrationResult[];
  updatedSentinels: string[];
  refreshedContext: boolean;
  warnings: string[];
  dryRun: boolean;
}

export interface GlobalMigrationReport {
  migratedConfig: boolean;
  migratedProjects: boolean;
  migratedWorkflows: number;
  migratedSchedules: boolean;
  migratedCategories: boolean;
  migratedSkills: number;
  migratedVaults: number;
  sourceDir: string;
  targetDir: string;
  dryRun: boolean;
}

/**
 * Migration mappings for known legacy files within a workspace.
 */
const WORKSPACE_FILE_MAPPINGS: Array<{ legacy: string; primary: string }> = [
  { legacy: BRAND_CONFIG.files.manifest.legacy, primary: BRAND_CONFIG.files.manifest.primary },
  { legacy: BRAND_CONFIG.files.lock.legacy, primary: BRAND_CONFIG.files.lock.primary },
  { legacy: BRAND_CONFIG.files.knowledge.legacy, primary: BRAND_CONFIG.files.knowledge.primary },
  { legacy: BRAND_CONFIG.files.plan.legacy, primary: BRAND_CONFIG.files.plan.primary },
  { legacy: BRAND_CONFIG.files.handoff.legacy, primary: BRAND_CONFIG.files.handoff.primary },
  { legacy: BRAND_CONFIG.files.overview.legacy, primary: BRAND_CONFIG.files.overview.primary },
  { legacy: BRAND_CONFIG.files.state.legacy, primary: BRAND_CONFIG.files.state.primary },
  { legacy: BRAND_CONFIG.files.runningState.legacy, primary: BRAND_CONFIG.files.runningState.primary },
  { legacy: BRAND_CONFIG.files.analysisCache.legacy, primary: BRAND_CONFIG.files.analysisCache.primary },
  { legacy: BRAND_CONFIG.files.cursorRule.legacy, primary: BRAND_CONFIG.files.cursorRule.primary },
];

/**
 * Checks if a workspace contains legacy NexusFlow files.
 */
export async function isLegacyWorkspace(workspacePath: string): Promise<boolean> {
  const legacyManifest = path.join(workspacePath, BRAND_CONFIG.files.manifest.legacy);
  const primaryManifest = path.join(workspacePath, BRAND_CONFIG.files.manifest.primary);

  if (existsSync(legacyManifest) && !existsSync(primaryManifest)) {
    return true;
  }

  for (const mapping of WORKSPACE_FILE_MAPPINGS) {
    if (existsSync(path.join(workspacePath, mapping.legacy))) {
      return true;
    }
  }

  return false;
}

interface DirectoryMergeResult {
  transferredCount: number;
  conflicts: Array<{ legacyRel: string; primaryRel: string }>;
  unresolvedCount: number;
}

/**
 * Recursively merges entries from srcDir into destDir.
 * - Non-conflicting files and directories are moved.
 * - Conflicting files are preserved in srcDir without overwriting destDir.
 * - Empty subdirectories are cleaned up only after verifying all entries transferred.
 */
async function mergeDirectoryRecursive(
  srcDir: string,
  destDir: string,
  basePath: string,
  dryRun: boolean,
): Promise<DirectoryMergeResult> {
  const result: DirectoryMergeResult = {
    transferredCount: 0,
    conflicts: [],
    unresolvedCount: 0,
  };

  if (!existsSync(srcDir)) return result;

  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const legacyRel = path.relative(basePath, srcPath);
    const primaryRel = path.relative(basePath, destPath);

    if (entry.isDirectory()) {
      if (!existsSync(destPath)) {
        if (!dryRun) {
          try {
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.rename(srcPath, destPath);
            result.transferredCount++;
          } catch {
            await fs.mkdir(destPath, { recursive: true });
            const sub = await mergeDirectoryRecursive(srcPath, destPath, basePath, dryRun);
            result.transferredCount += sub.transferredCount;
            result.conflicts.push(...sub.conflicts);
            result.unresolvedCount += sub.unresolvedCount;
            try {
              const remaining = await fs.readdir(srcPath);
              if (remaining.length === 0) {
                await fs.rmdir(srcPath);
              } else {
                result.unresolvedCount += remaining.length;
              }
            } catch {}
          }
        } else {
          result.transferredCount++;
        }
      } else {
        if (!dryRun) {
          await fs.mkdir(destPath, { recursive: true });
        }
        const sub = await mergeDirectoryRecursive(srcPath, destPath, basePath, dryRun);
        result.transferredCount += sub.transferredCount;
        result.conflicts.push(...sub.conflicts);
        result.unresolvedCount += sub.unresolvedCount;

        if (!dryRun) {
          try {
            const remaining = await fs.readdir(srcPath);
            if (remaining.length === 0) {
              await fs.rmdir(srcPath);
            }
          } catch {}
        }
      }
    } else {
      // File or symlink
      if (!existsSync(destPath)) {
        if (!dryRun) {
          try {
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.rename(srcPath, destPath);
            result.transferredCount++;
          } catch {
            result.conflicts.push({ legacyRel, primaryRel });
            result.unresolvedCount++;
          }
        } else {
          result.transferredCount++;
        }
      } else {
        // Destination already exists; do not overwrite, preserve in legacy source
        result.conflicts.push({ legacyRel, primaryRel });
        result.unresolvedCount++;
      }
    }
  }

  return result;
}

/**
 * Migrates a single workspace from NexusFlow to ContextSpace.
 */
export async function migrateWorkspace(
  workspacePath: string,
  options: { dryRun?: boolean; refresh?: boolean } = {},
): Promise<WorkspaceMigrationReport> {
  const dryRun = options.dryRun ?? false;
  const doRefresh = options.refresh ?? true;
  const resolvedPath = path.resolve(workspacePath);

  const feature = await loadFeatureConfig(resolvedPath);
  const featureId = feature?.id || feature?.branchName || path.basename(resolvedPath);

  const report: WorkspaceMigrationReport = {
    workspacePath: resolvedPath,
    featureId,
    isLegacy: false,
    renamedFiles: [],
    updatedSentinels: [],
    refreshedContext: false,
    warnings: [],
    dryRun,
  };

  // 1. Rename files from legacy to primary
  for (const mapping of WORKSPACE_FILE_MAPPINGS) {
    const legacyPath = path.join(resolvedPath, mapping.legacy);
    const primaryPath = path.join(resolvedPath, mapping.primary);

    if (existsSync(legacyPath)) {
      report.isLegacy = true;
      if (existsSync(primaryPath)) {
        report.renamedFiles.push({
          from: mapping.legacy,
          to: mapping.primary,
          status: 'skipped',
          error: 'Primary target already exists',
        });
      } else {
        if (!dryRun) {
          try {
            await fs.mkdir(path.dirname(primaryPath), { recursive: true });
            await fs.rename(legacyPath, primaryPath);
            report.renamedFiles.push({
              from: mapping.legacy,
              to: mapping.primary,
              status: 'renamed',
            });
          } catch (err: any) {
            report.renamedFiles.push({
              from: mapping.legacy,
              to: mapping.primary,
              status: 'failed',
              error: err.message,
            });
          }
        } else {
          report.renamedFiles.push({
            from: mapping.legacy,
            to: mapping.primary,
            status: 'renamed',
          });
        }
      }
    }
  }

  // 2. Migrate legacy directories (e.g., .nexusflow/ -> .contextspace/)
  const legacyDir = path.join(resolvedPath, BRAND_CONFIG.files.configDir.legacy);
  const primaryDir = path.join(resolvedPath, BRAND_CONFIG.files.configDir.primary);
  if (existsSync(legacyDir)) {
    report.isLegacy = true;

    const handleMergeResult = async (mergeResult: DirectoryMergeResult) => {
      if (!dryRun) {
        try {
          const remaining = await fs.readdir(legacyDir);
          if (remaining.length === 0) {
            await fs.rmdir(legacyDir);
          }
        } catch {}
      }

      for (const conflict of mergeResult.conflicts) {
        report.warnings.push(
          `Conflicting legacy file preserved: ${conflict.legacyRel} (target ${conflict.primaryRel} already exists)`,
        );
        report.renamedFiles.push({
          from: conflict.legacyRel,
          to: conflict.primaryRel,
          status: 'skipped',
          error: 'Target already exists',
        });
      }

      const stillExists = existsSync(legacyDir);
      if (stillExists || mergeResult.conflicts.length > 0) {
        report.renamedFiles.push({
          from: BRAND_CONFIG.files.configDir.legacy,
          to: BRAND_CONFIG.files.configDir.primary,
          status: 'skipped',
          error: `${mergeResult.conflicts.length} conflicting files preserved in legacy directory`,
        });
      } else {
        report.renamedFiles.push({
          from: BRAND_CONFIG.files.configDir.legacy,
          to: BRAND_CONFIG.files.configDir.primary,
          status: 'renamed',
        });
      }
    };

    if (!existsSync(primaryDir)) {
      if (!dryRun) {
        try {
          await fs.rename(legacyDir, primaryDir);
          report.renamedFiles.push({
            from: BRAND_CONFIG.files.configDir.legacy,
            to: BRAND_CONFIG.files.configDir.primary,
            status: 'renamed',
          });
        } catch (err: any) {
          // Fall back to recursive merge if atomic rename failed
          await fs.mkdir(primaryDir, { recursive: true });
          const mergeResult = await mergeDirectoryRecursive(legacyDir, primaryDir, resolvedPath, dryRun);
          await handleMergeResult(mergeResult);
        }
      } else {
        report.renamedFiles.push({
          from: BRAND_CONFIG.files.configDir.legacy,
          to: BRAND_CONFIG.files.configDir.primary,
          status: 'renamed',
        });
      }
    } else {
      // Both legacyDir and primaryDir exist: merge recursively without overwriting conflicting content
      const mergeResult = await mergeDirectoryRecursive(legacyDir, primaryDir, resolvedPath, dryRun);
      await handleMergeResult(mergeResult);
    }
  }

  // 3. Update sentinels in durable markdown files
  // Note: Only generated sentinel comments and provenance lines are updated.
  // We NEVER replace prose, decisions, code snippets, git hashes, or commands in user files.
  // Generated views (AGENTS.md, CLAUDE.md) are regenerated directly from source in step 5.
  const durableFiles = [
    BRAND_CONFIG.files.knowledge.primary,
    BRAND_CONFIG.files.plan.primary,
    BRAND_CONFIG.files.handoff.primary,
    BRAND_CONFIG.files.overview.primary,
  ];

  for (const rel of durableFiles) {
    const filePath = path.join(resolvedPath, rel);
    try {
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      let updated = content;

      // Update freshness comment block (tags and banner lines within the block)
      updated = updated.replace(
        /<!--\s*NEXUSFLOW:FRESHNESS:START\s*-->([\s\S]*?)<!--\s*NEXUSFLOW:FRESHNESS:END\s*-->/g,
        (_match, inner) => {
          const updatedInner = inner
            .replace(/NEXUSFLOW/g, BRAND_CONFIG.identity.name.toUpperCase())
            .replace(/NexusFlow/g, BRAND_CONFIG.identity.name)
            .replace(/nexusflow/g, BRAND_CONFIG.identity.cliName);
          return `<!-- ${BRAND_CONFIG.sentinels.freshnessStart[0]} -->${updatedInner}<!-- ${BRAND_CONFIG.sentinels.freshnessEnd[0]} -->`;
        },
      );
      // Update generated provenance header
      updated = updated.replace(/<!-- AUTO-GENERATED by NexusFlow/g, `<!-- AUTO-GENERATED by ${BRAND_CONFIG.identity.name}`);

      if (updated !== content) {
        if (!dryRun) {
          await fs.writeFile(filePath, updated, 'utf-8');
        }
        report.updatedSentinels.push(rel);
      }
    } catch (e: any) {
      report.warnings.push(`Failed to update markdown sentinels in ${rel}: ${e.message}`);
    }
  }

  // 4. Update .gitignore
  // Durable workspace artifacts must NEVER be ignored, as they are tracked by workspace Git.
  // We only ignore ephemeral state (analysis cache, runtime workspace state, locks, staging, logs).
  const gitignorePath = path.join(resolvedPath, '.gitignore');
  try {
    const gitignore = await fs.readFile(gitignorePath, 'utf-8');
    const lines = gitignore.split('\n');

    const durablePatterns = [
      /^(\/)?contextspace\.json$/,
      /^(\/)?contextspace\.lock$/,
      /^(\/)?contextspace-.*\.md$/,
      /^(\/)?contextspace-knowledge\.md$/,
      /^(\/)?contextspace-plan\.md$/,
      /^(\/)?contextspace-overview\.md$/,
      /^(\/)?contextspace-handoff\.md$/,
      /^(\/)?\.contextspace$/,
      /^(\/)?\.contextspace\/$/,
      /^(\/)?\.contextspace\*$/,
      /^(\/)?nexusflow\.json$/,
      /^(\/)?nexusflow\.lock$/,
      /^(\/)?nexusflow-.*\.md$/,
      /^(\/)?nexusflow-knowledge\.md$/,
      /^(\/)?nexusflow-plan\.md$/,
      /^(\/)?nexusflow-overview\.md$/,
      /^(\/)?nexusflow-handoff\.md$/,
      /^(\/)?\.nexusflow$/,
      /^(\/)?\.nexusflow\/$/,
      /^(\/)?\.nexusflow\*$/,
    ];

    const isDurableRule = (l: string) => {
      const t = l.trim();
      return durablePatterns.some((p) => p.test(t));
    };

    const ephemeralRules = [
      `/${BRAND_CONFIG.files.analysisCache.primary}`,
      `/${BRAND_CONFIG.files.configDir.primary}/workspace-state.json`,
      `/${BRAND_CONFIG.files.configDir.primary}/*.lock`,
      `/${BRAND_CONFIG.files.configDir.primary}/resource-staging-*`,
      `/${BRAND_CONFIG.files.configDir.primary}/logs/`,
    ];

    const hasRule = (rule: string) => {
      const noSlash = rule.startsWith('/') ? rule.slice(1) : rule;
      const withSlash = rule.startsWith('/') ? rule : '/' + rule;
      return lines.some((l) => l.trim() === noSlash || l.trim() === withSlash);
    };

    const missingEphemeral = ephemeralRules.filter((r) => !hasRule(r));
    const filteredLines = lines.filter((l) => !isDurableRule(l));

    const changed = lines.length !== filteredLines.length || missingEphemeral.length > 0;
    const finalLines = [...filteredLines];

    if (missingEphemeral.length > 0) {
      finalLines.push('# ContextSpace ephemeral state', ...missingEphemeral);
    }

    if (changed) {
      if (!dryRun) {
        const cleaned = finalLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        await fs.writeFile(gitignorePath, cleaned, 'utf-8');
      }
      report.updatedSentinels.push('.gitignore');
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      report.warnings.push(`Failed to update .gitignore: ${err.message}`);
    }
  }

  // 5. Trigger refresh to ensure all context files match
  if (!dryRun && doRefresh) {
    try {
      await refreshWorkspace(resolvedPath, { force: true });
      report.refreshedContext = true;
    } catch (e: any) {
      report.warnings.push(`Workspace refreshed with warning: ${e.message}`);
    }
  }

  return report;
}

/**
 * Helper to recursively copy files and directories from src to dest.
 */
async function copyDirRecursive(src: string, dest: string, dryRun: boolean): Promise<number> {
  let copied = 0;
  if (!existsSync(src)) return 0;
  if (!dryRun) {
    await fs.mkdir(dest, { recursive: true });
  }
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += await copyDirRecursive(srcPath, destPath, dryRun);
    } else if (entry.isFile()) {
      if (!existsSync(destPath)) {
        if (!dryRun) {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(srcPath, destPath);
        }
        copied++;
      }
    }
  }
  return copied;
}

export interface GlobalMigrationOptions {
  dryRun?: boolean;
  sourceDir?: string;
  targetDir?: string;
}

/**
 * Migrates global configuration and durable user state (~/.nexusflow -> ~/.contextspace).
 */
export async function migrateGlobalConfig(options: GlobalMigrationOptions = {}): Promise<GlobalMigrationReport> {
  const dryRun = options.dryRun ?? false;
  const legacyHome = options.sourceDir ?? path.join(os.homedir(), BRAND_CONFIG.files.configDir.legacy);
  const primaryHome = options.targetDir ?? path.join(os.homedir(), BRAND_CONFIG.files.configDir.primary);

  const report: GlobalMigrationReport = {
    migratedConfig: false,
    migratedProjects: false,
    migratedWorkflows: 0,
    migratedSchedules: false,
    migratedCategories: false,
    migratedSkills: 0,
    migratedVaults: 0,
    sourceDir: legacyHome,
    targetDir: primaryHome,
    dryRun,
  };

  if (!existsSync(legacyHome)) {
    return report;
  }

  if (!dryRun) {
    await fs.mkdir(primaryHome, { recursive: true });
  }

  // 1. config.json
  const legacyConfig = path.join(legacyHome, 'config.json');
  const primaryConfig = path.join(primaryHome, 'config.json');
  if (existsSync(legacyConfig) && !existsSync(primaryConfig)) {
    if (!dryRun) {
      await fs.copyFile(legacyConfig, primaryConfig);
    }
    report.migratedConfig = true;
  }

  // 2. projects.json
  const legacyProjects = path.join(legacyHome, 'projects.json');
  const primaryProjects = path.join(primaryHome, 'projects.json');
  if (existsSync(legacyProjects) && !existsSync(primaryProjects)) {
    if (!dryRun) {
      await fs.copyFile(legacyProjects, primaryProjects);
    }
    report.migratedProjects = true;
  }

  // 3. schedules.json
  const legacySchedules = path.join(legacyHome, 'schedules.json');
  const primarySchedules = path.join(primaryHome, 'schedules.json');
  if (existsSync(legacySchedules) && !existsSync(primarySchedules)) {
    if (!dryRun) {
      await fs.copyFile(legacySchedules, primarySchedules);
    }
    report.migratedSchedules = true;
  }

  // 4. categories.json
  const legacyCategories = path.join(legacyHome, 'categories.json');
  const primaryCategories = path.join(primaryHome, 'categories.json');
  if (existsSync(legacyCategories) && !existsSync(primaryCategories)) {
    if (!dryRun) {
      await fs.copyFile(legacyCategories, primaryCategories);
    }
    report.migratedCategories = true;
  }

  // 5. daemon.json
  const legacyDaemon = path.join(legacyHome, 'daemon.json');
  const primaryDaemon = path.join(primaryHome, 'daemon.json');
  if (existsSync(legacyDaemon) && !existsSync(primaryDaemon)) {
    if (!dryRun) {
      await fs.copyFile(legacyDaemon, primaryDaemon);
    }
  }

  // 6. workflows/
  const legacyWorkflows = path.join(legacyHome, 'workflows');
  const primaryWorkflows = path.join(primaryHome, 'workflows');
  if (existsSync(legacyWorkflows)) {
    try {
      const entries = await fs.readdir(legacyWorkflows, { withFileTypes: true });
      if (!dryRun) {
        await fs.mkdir(primaryWorkflows, { recursive: true });
      }
      for (const entry of entries) {
        const src = path.join(legacyWorkflows, entry.name);
        const dest = path.join(primaryWorkflows, entry.name);
        if (!existsSync(dest)) {
          if (entry.isDirectory()) {
            await copyDirRecursive(src, dest, dryRun);
          } else if (entry.isFile()) {
            if (!dryRun) {
              await fs.copyFile(src, dest);
            }
          }
          report.migratedWorkflows++;
        }
      }
    } catch {}
  }

  // 7. skills/
  const legacySkills = path.join(legacyHome, 'skills');
  const primarySkills = path.join(primaryHome, 'skills');
  if (existsSync(legacySkills)) {
    try {
      const entries = await fs.readdir(legacySkills, { withFileTypes: true });
      if (!dryRun) {
        await fs.mkdir(primarySkills, { recursive: true });
      }
      for (const entry of entries) {
        const src = path.join(legacySkills, entry.name);
        const dest = path.join(primarySkills, entry.name);
        if (!existsSync(dest)) {
          if (entry.isDirectory()) {
            await copyDirRecursive(src, dest, dryRun);
          } else if (entry.isFile()) {
            if (!dryRun) {
              await fs.copyFile(src, dest);
            }
          }
          report.migratedSkills++;
        }
      }
    } catch {}
  }

  // 8. vault/
  const legacyVault = path.join(legacyHome, 'vault');
  const primaryVault = path.join(primaryHome, 'vault');
  if (existsSync(legacyVault)) {
    try {
      const entries = await fs.readdir(legacyVault, { withFileTypes: true });
      if (!dryRun) {
        await fs.mkdir(primaryVault, { recursive: true });
      }
      for (const entry of entries) {
        const src = path.join(legacyVault, entry.name);
        const dest = path.join(primaryVault, entry.name);
        if (!existsSync(dest)) {
          if (entry.isDirectory()) {
            await copyDirRecursive(src, dest, dryRun);
          } else if (entry.isFile()) {
            if (!dryRun) {
              await fs.copyFile(src, dest);
            }
          }
          report.migratedVaults++;
        }
      }
    } catch {}
  }

  // 9. Any other unhandled files or directories in legacyHome
  try {
    const allEntries = await fs.readdir(legacyHome, { withFileTypes: true });
    const handled = new Set([
      'config.json',
      'projects.json',
      'schedules.json',
      'categories.json',
      'daemon.json',
      'workflows',
      'skills',
      'vault',
    ]);
    for (const entry of allEntries) {
      if (handled.has(entry.name)) continue;
      const src = path.join(legacyHome, entry.name);
      const dest = path.join(primaryHome, entry.name);
      if (!existsSync(dest)) {
        if (entry.isDirectory()) {
          await copyDirRecursive(src, dest, dryRun);
        } else if (entry.isFile()) {
          if (!dryRun) {
            await fs.copyFile(src, dest);
          }
        }
      }
    }
  } catch {}

  return report;
}
