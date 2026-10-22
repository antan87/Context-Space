/**
 * @module commands/skill
 * CLI commands `ctxspace skill` — list, inspect, create, and remove agent skills.
 */

import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import fse from 'fs-extra';

import { quarantineHarnessSkill, restoreHarnessSkill, listQuarantinedHarnessSkills } from '../utils/harness-skill-quarantine.js';
import { getAllSkills, saveSkill, deleteSkill, type SkillDiagnostic, type SkillItem } from '../utils/skills-catalog.js';
import { resolveWorkspaceInteractive, resolveWorkspaceQuiet } from '../utils/resolve-workspace.js';
import { refreshWorkspace } from '../core/refresh.js';
import { BRAND_NAME } from '../core/constants.js';
import { LOCAL_SKILLS_FOLDER } from '../harnesses/registry.js';

export interface SkillListOptions {
  json?: boolean;
  scope?: 'all' | 'workspace' | 'global';
  tag?: string | string[];
}

export async function skillListCommand(workspaceArg?: string, options: SkillListOptions = {}): Promise<void> {
  let workspacePath: string | null = null;
  if (workspaceArg) {
    try {
      workspacePath = await resolveWorkspaceQuiet(workspaceArg);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
      return;
    }
  } else {
    workspacePath = await resolveWorkspaceQuiet().catch(() => null);
  }
  const skills = await getAllSkills(workspacePath || undefined);

  let filtered = skills;
  if (options.scope === 'workspace') {
    filtered = filtered.filter((s) => s.scope === 'workspace');
  } else if (options.scope === 'global') {
    filtered = filtered.filter((s) => s.scope !== 'workspace');
  }
  if (options.tag) {
    const tags = (Array.isArray(options.tag) ? options.tag : [options.tag]).map((tag) => tag.toLowerCase().trim());
    filtered = filtered.filter((s) => tags.every((tag) => s.tags?.some((t) => t.toLowerCase() === tag)));
  }

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`\n🛠️  ${BRAND_NAME} — Agent Skills\n`));

  if (workspacePath) {
    console.log(chalk.dim('Workspace: ') + chalk.bold(path.basename(workspacePath)) + '\n');
  }

  if (filtered.length === 0) {
    console.log(chalk.dim('  (No skills found in catalog.)\n'));
    console.log(chalk.dim('  Create a skill with: ') + chalk.cyan('ctxspace skill create <id>\n'));
    return;
  }

  const workspaceSkills = filtered.filter((s) => s.scope === 'workspace');
  const globalSkills = filtered.filter((s) => s.scope !== 'workspace');

  if (workspaceSkills.length > 0) {
    console.log(chalk.bold.yellow('📂 Workspace-Specific Skills (local to this project):'));
    for (const s of workspaceSkills) {
      const tagsStr = s.tags?.length ? chalk.dim(` [${s.tags.join(', ')}]`) : '';
      console.log(`  ${chalk.green('●')} ${chalk.bold(s.id)} — ${s.title}${tagsStr}`);
      if (s.description) console.log(chalk.dim(`    ${s.description}`));
    }
    console.log('');
  }

  if (globalSkills.length > 0) {
    console.log(chalk.bold.blue('🌐 Global Company Skills (shared across workspaces):'));
    for (const s of globalSkills) {
      const tagsStr = s.tags?.length ? chalk.dim(` [${s.tags.join(', ')}]`) : '';
      const sourceStr = s.source ? chalk.dim(` (${s.source.label})`) : '';
      console.log(`  ${chalk.blue('●')} ${chalk.bold(s.id)} — ${s.title}${sourceStr}${tagsStr}`);
      if (s.description) console.log(chalk.dim(`    ${s.description}`));
    }
    console.log('');
  }
}

export interface SkillLintOptions {
  json?: boolean;
  /** Also fail (exit code 1) when a skill loads but has something to review. */
  strict?: boolean;
}

/**
 * `ctxspace skill lint`: report every skill that was not loaded, or loads with a problem, using the
 * same diagnostics the Skills page shows. Exits non-zero when a skill was not loaded (or, with
 * `--strict`, when anything is reported), so a script or CI job can gate on it.
 */
export async function skillLintCommand(workspaceArg?: string, options: SkillLintOptions = {}): Promise<void> {
  let workspacePath: string | null = null;
  if (workspaceArg) {
    try {
      workspacePath = await resolveWorkspaceQuiet(workspaceArg);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
      return;
    }
  } else {
    workspacePath = await resolveWorkspaceQuiet().catch(() => null);
  }

  const allDiagnostics: SkillDiagnostic[] = [];
  const skills = await getAllSkills(workspacePath || undefined, allDiagnostics);
  // Problems in a harness's own skill files are shown on the Skills page, but they are not the user's to fix or gate on.
  const diagnostics = allDiagnostics.filter((d) => !d.source);
  const isError = (d: SkillDiagnostic) => (d.level ?? 'error') === 'error';
  const errors = diagnostics.filter(isError);
  const warnings = diagnostics.filter((d) => !isError(d));
  if (errors.length > 0 || (options.strict && warnings.length > 0)) process.exitCode = 1;

  if (options.json) {
    console.log(JSON.stringify({ skills: skills.length, errors: errors.length, warnings: warnings.length, diagnostics }, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`\n🔎 ${BRAND_NAME} — Skill check\n`));
  if (workspacePath) console.log(chalk.dim('Workspace: ') + chalk.bold(path.basename(workspacePath)) + '\n');

  if (diagnostics.length === 0) {
    console.log(chalk.green(`  ✔ ${skills.length} skills loaded, nothing to fix.\n`));
    return;
  }
  for (const d of diagnostics) {
    const mark = isError(d) ? chalk.red('✖') : chalk.yellow('⚠');
    console.log(`  ${mark} ${chalk.bold(d.id)} ${chalk.dim(`(${d.scope})`)}`);
    console.log(`    ${d.message}`);
  }
  console.log('');
  console.log(`  ${skills.length} skills loaded; ${errors.length} not loaded, ${warnings.length} to review.\n`);
}

export interface SkillCreateOptions {
  title?: string;
  description?: string;
  content?: string;
  tags?: string[];
  tag?: string[] | string;
  scope?: 'workspace' | 'global';
  file?: string;
}

export async function skillCreateCommand(
  id: string,
  workspaceArg?: string,
  options: SkillCreateOptions = {},
): Promise<void> {
  const cleanId = id.trim().toLowerCase();
  if (!cleanId) {
    console.error(chalk.red('Error: Skill ID is required.'));
    process.exit(1);
  }

  let workspacePath: string | null = null;
  const scope = options.scope ?? (workspaceArg ? 'workspace' : 'global');

  if (scope === 'workspace') {
    workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select workspace for this local skill:');
    if (!workspacePath) {
      console.error(chalk.red('Error: A workspace must be selected for workspace-scoped skills.'));
      process.exit(1);
    }
  }

  let content = options.content ?? '';
  if (options.file) {
    try {
      content = await fs.readFile(options.file, 'utf-8');
    } catch (err: any) {
      console.error(chalk.red(`Error reading skill file: ${err.message}`));
      process.exit(1);
    }
  }

  const title = options.title || cleanId;
  const description = options.description || `Skill for ${cleanId}`;
  if (!content) {
    content = `# ${title}\n\n${description}\n\n## Instructions\n1. Follow standard procedures.`;
  }

  try {
    const tags = options.tag ?? options.tags ?? [];
    const saved = await saveSkill(
      {
        id: cleanId,
        name: cleanId,
        title,
        description,
        content,
        tags: Array.isArray(tags) ? tags : [tags],
      },
      {
        scope,
        workspacePath: workspacePath || undefined,
      },
    );

    if (workspacePath) {
      await refreshWorkspace(workspacePath, { force: true }).catch(() => {});
    }

    console.log(chalk.green(`\n✔ Skill "${saved.title || saved.id}" created successfully!`));
    console.log(chalk.dim(`  Scope:   ${scope === 'workspace' ? 'Workspace-local' : 'Global'}`));
    console.log(chalk.dim(`  Path:    ${(saved as any).path}`));
    if (saved.tags?.length) {
      console.log(chalk.dim(`  Tags:    ${saved.tags.join(', ')}`));
    }
    console.log('');
  } catch (err: any) {
    console.error(chalk.red(`\nError creating skill: ${err.message}\n`));
    process.exit(1);
  }
}

export async function skillDeleteCommand(
  id: string,
  workspaceArg?: string,
  options: { scope?: 'workspace' | 'global' } = {},
): Promise<void> {
  const cleanId = id.trim().toLowerCase();
  if (!cleanId) {
    console.error(chalk.red('Error: Skill ID is required.'));
    process.exitCode = 1;
    return;
  }

  let scope: 'workspace' | 'global';
  let workspacePath: string | null = null;

  if (options.scope === 'global') {
    scope = 'global';
  } else if (options.scope === 'workspace') {
    scope = 'workspace';
    workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace:').catch(() => null);
    if (!workspacePath) {
      console.error(chalk.red('Error: A workspace must be selected to delete a workspace-scoped skill.'));
      process.exitCode = 1;
      return;
    }
  } else {
    workspacePath = await resolveWorkspaceQuiet(workspaceArg).catch(() => null);
    if (workspacePath) {
      const wsSkillDir = path.join(workspacePath, ...LOCAL_SKILLS_FOLDER.split('/'), cleanId);
      const existsLocally = await fse.pathExists(wsSkillDir);
      scope = existsLocally ? 'workspace' : 'global';
    } else {
      scope = 'global';
    }
  }

  try {
    await deleteSkill(cleanId, {
      scope,
      workspacePath: workspacePath || undefined,
    });

    if (workspacePath && scope === 'workspace') {
      await refreshWorkspace(workspacePath, { force: true }).catch(() => {});
    }

    console.log(chalk.green(`\n✔ Skill "${cleanId}" deleted successfully (${scope} scope).\n`));
  } catch (err: any) {
    console.error(chalk.red(`\nError deleting skill: ${err.message}\n`));
    process.exitCode = 1;
  }
}

export interface SkillShowOptions {
  json?: boolean;
}

export async function skillShowCommand(
  id: string,
  workspaceArg?: string,
  options: SkillShowOptions = {},
): Promise<void> {
  const cleanId = id.trim().toLowerCase();
  if (!cleanId) {
    console.error(chalk.red('Error: Skill ID is required.'));
    process.exitCode = 1;
    return;
  }

  let workspacePath: string | null = null;
  if (workspaceArg) {
    try {
      workspacePath = await resolveWorkspaceQuiet(workspaceArg);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exitCode = 1;
      return;
    }
  } else {
    workspacePath = await resolveWorkspaceQuiet().catch(() => null);
  }

  const skills = await getAllSkills(workspacePath || undefined);
  const skill = skills.find((s) => s.id.toLowerCase() === cleanId || s.name?.toLowerCase() === cleanId);

  if (!skill) {
    console.error(chalk.red(`\nError: Skill "${id}" not found in catalog or workspace.\n`));
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`\n🛠️  Skill: ${skill.title || skill.id} (${chalk.bold(skill.id)})\n`));
  console.log(chalk.dim('Scope:        ') + (skill.scope === 'workspace' ? chalk.yellow('Workspace-local') : chalk.blue('Global / Personal')));
  console.log(chalk.dim('Category:     ') + chalk.magenta(skill.category || 'general'));
  if (skill.sourcePath) {
    console.log(chalk.dim('Source Path:  ') + chalk.dim(skill.sourcePath));
  }
  if (skill.description) {
    console.log(chalk.dim('Description:  ') + skill.description);
  }
  if (skill.tags?.length) {
    console.log(chalk.dim('Tags:         ') + skill.tags.join(', '));
  }
  if (skill.allowedTools?.length) {
    console.log(chalk.dim('Allowed Tools:') + ' ' + skill.allowedTools.join(', '));
  }
  if (skill.references?.length) {
    console.log(chalk.dim('\nReferences:'));
    for (const ref of skill.references) {
      console.log(`  • ${chalk.bold(ref.name)} ${chalk.dim(`(${ref.relativePath})`)}`);
    }
  }
  if (skill.scripts?.length) {
    console.log(chalk.dim('\nScripts:'));
    for (const script of skill.scripts) {
      console.log(`  • ${chalk.bold(script.name)} ${chalk.dim(`(${script.relativePath})`)}`);
    }
  }

  if (skill.content) {
    console.log(chalk.dim('\n─── Instructions ──────────────────────────────────────────'));
    console.log(skill.content.trim());
    console.log(chalk.dim('───────────────────────────────────────────────────────────\n'));
  } else {
    console.log();
  }
}

/** `ctxspace skill quarantine <id>`: moves a harness-owned skill out of its harness folder, where it can be restored. */
export async function skillQuarantineCommand(id: string): Promise<void> {
  try {
    const entry = await quarantineHarnessSkill(id);
    console.log(chalk.green(`\n✔ Moved "${entry.id}" out of ${entry.label}.`));
    console.log(chalk.dim(`  Was: ${entry.originalPath}`));
    console.log(chalk.dim(`  Kept in: ${path.join(entry.entryDir, 'skill')}`));
    console.log(chalk.dim(`  Restore with: ctxspace skill restore ${entry.id}\n`));
  } catch (error) {
    console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exitCode = 1;
  }
}

/** `ctxspace skill restore <id>`: puts a quarantined harness skill back where it was. */
export async function skillRestoreCommand(id: string): Promise<void> {
  try {
    const entry = await restoreHarnessSkill(id);
    console.log(chalk.green(`\n✔ Restored "${entry.id}" to ${entry.originalPath}\n`));
  } catch (error) {
    console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exitCode = 1;
  }
}

/** `ctxspace skill quarantined`: lists harness skills that are in quarantine. */
export async function skillQuarantinedCommand(): Promise<void> {
  const entries = await listQuarantinedHarnessSkills();
  if (entries.length === 0) {
    console.log(chalk.dim('\n  No harness skills are in quarantine.\n'));
    return;
  }
  console.log(chalk.bold.cyan('\nQuarantined harness skills:\n'));
  for (const entry of entries) {
    console.log(`  ${chalk.bold(entry.id)} ${chalk.dim(`(${entry.label}, moved ${entry.quarantinedAt})`)}`);
    console.log(chalk.dim(`    Was: ${entry.originalPath}`));
  }
  console.log('');
}
