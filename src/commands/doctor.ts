/**
 * @module commands/doctor
 * Renders the structured workspace diagnostics produced by `core/doctor.ts`.
 */

import chalk from 'chalk';

import { loadFeatureConfig } from '../core/workspace.js';
import { runDoctor, type DoctorCheck, type DoctorCheckStatus } from '../core/doctor.js';
import { resolveWorkspaceInteractive } from '../utils/resolve-workspace.js';
import { BRAND_NAME, PRIMARY_MANIFEST_FILE } from '../core/constants.js';

/** Category display order + emoji, matching the previous doctor layout. */
const CATEGORY_LABELS: Record<string, string> = {
  'Worktree Paths': '📁 Worktree Paths:',
  'Branch Alignment & Git Status': '🌿 Branch Alignment & Git Status:',
  'Local Package Setup': '📦 Local Package Setup & Reference Versioning:',
  'Test Commands': '🧪 Test Commands:',
  'Core Artifacts': '📄 Core Artifacts:',
  'Generated Context': '🔒 Generated Context Provenance:',
  'Workspace Backup': '💾 Workspace Backup:',
  'Explicit Contracts': '🔗 Explicit Runtime Contracts:',
  'AI Agent MCP': '🔌 AI Agent MCP Server:',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

function mark(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return chalk.green('✔');
    case 'warn':
      return chalk.yellow('⚠');
    case 'fail':
      return chalk.red('✖');
    default:
      return chalk.dim('○');
  }
}

function renderCheck(check: DoctorCheck): string {
  const label = check.name && check.name !== check.category ? `${check.name}: ` : '';
  return `  ${mark(check.status)} ${label}${check.message}`;
}

/**
 * Runs the doctor command to diagnose workspace state.
 *
 * @param workspaceArg - Optional workspace path.
 */
export async function doctorCommand(workspaceArg?: string): Promise<void> {
  console.log(chalk.bold.cyan(`\n🩺 ${BRAND_NAME} — Workspace Doctor\n`));

  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace to diagnose:');
  if (!workspacePath) return;

  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    console.error(chalk.red(`✖ Failed to load workspace configuration. Ensure ${PRIMARY_MANIFEST_FILE} exists.`));
    return;
  }

  console.log(chalk.cyan('Running diagnostics...\n'));

  const report = await runDoctor(workspacePath);

  // Render checks grouped by category, in the canonical order.
  const seen = new Set<string>();
  const categories = [
    ...CATEGORY_ORDER.filter((cat) => report.checks.some((ch) => ch.category === cat)),
    ...report.checks.map((ch) => ch.category).filter((cat) => !CATEGORY_ORDER.includes(cat)),
  ];

  for (const category of categories) {
    if (seen.has(category)) continue;
    seen.add(category);
    console.log(chalk.bold(CATEGORY_LABELS[category] ?? `${category}:`));
    for (const check of report.checks.filter((ch) => ch.category === category)) {
      console.log(renderCheck(check));
    }
    console.log();
  }

  if (report.aborted) {
    console.error(chalk.red('✖ Worktree errors detected. Cannot complete diagnostics.\n'));
    return;
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(chalk.bold('📊 Diagnostic Summary:'));
  if (report.healthy) {
    console.log(chalk.bold.green('  ✔ All checks passed! Workspace is healthy.\n'));
  } else {
    if (report.errors.length > 0) {
      console.log(chalk.bold.red(`  ✖ ${report.errors.length} error(s) found. Fix them before proceeding.`));
      for (const err of report.errors) console.log(`    - ${err}`);
    }
    if (report.warnings.length > 0) {
      console.log(chalk.bold.yellow(`  ⚠ ${report.warnings.length} warning(s) found.`));
      for (const warn of report.warnings) console.log(`    - ${warn}`);
    }
    console.log();
  }
}
