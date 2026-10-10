/**
 * @module commands/finish
 * `nexusflow finish` — closes the loop that `create` opens: commit and push
 * every repo, surface PR links, promote reusable learnings into base knowledge,
 * and optionally remove the workspace once everything is safely pushed.
 */

import chalk from 'chalk';
import { confirm, checkbox, select } from '@inquirer/prompts';

import { loadFeatureConfig, deleteWorkspace } from '../core/workspace.js';
import { stopServices } from '../orchestration/runner.js';
import { getWorkspaceStatusReport } from '../core/status.js';
import { finishWorkspace, type FinishReport, type RepoFinishReport } from '../core/finish.js';
import { evaluateProgression } from '../core/progression-policy.js';
import { getWorkspaceRepos } from '../utils/multi-git.js';
import { resolveWorkspaceInteractive } from '../utils/resolve-workspace.js';
import { readWorkspaceKnowledge, parseKnowledgeEntries, promoteKnowledge, type KnowledgeEntryType } from '../core/knowledge.js';
import { BRAND_NAME, CLI_NAME } from '../core/constants.js';
import { archiveWorkspace } from '../core/archive.js';
import { reportArchiveOutcome } from './archive.js';

interface FinishCommandOptions {
  message?: string;
  pr?: boolean; // --no-pr → false
  knowledge?: boolean; // --no-knowledge → false
  cleanup?: boolean;
  /** Archive afterwards: remove worktrees, keep the record. */
  archive?: boolean;
  /** With `archive`: also archive pushed-but-unmerged work, keeping its branch. */
  park?: boolean;
  /** Accepts non-destructive defaults. Never bypasses verification. */
  yes?: boolean;
  dryRun?: boolean;
  /** Finish without fresh passing verification; the reason is recorded. */
  overrideVerification?: string;
}

const PROMOTABLE_TYPES: KnowledgeEntryType[] = ['decision', 'gotcha', 'assumption'];

function oneLine(text: string, max = 72): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

export async function finishCommand(
  workspaceArg: string | undefined,
  options: FinishCommandOptions,
): Promise<void> {
  console.log(chalk.bold.cyan(`\n🏁 ${BRAND_NAME} — Finish Feature\n`));

  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace to finish:');
  if (!workspacePath) return;

  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    console.error(chalk.red('✖ Failed to load workspace configuration.'));
    return;
  }

  // ── Preflight ────────────────────────────────────────────────────────────
  const preflight = await getWorkspaceStatusReport(workspacePath);
  console.log(chalk.bold('Preflight status:'));
  // Pad the plain text *before* colorizing so ANSI codes don't skew alignment,
  // and size columns to the actual repo/branch names (they can be long).
  const nameW = Math.max(10, ...preflight.repos.map((r) => r.name.length)) + 2;
  const branchW = Math.max(6, ...preflight.repos.map((r) => (r.branch ?? '(detached)').length)) + 2;
  const dirtyW = 12;
  console.log(
    chalk.dim('  ' + 'Repository'.padEnd(nameW) + 'Branch'.padEnd(branchW) + 'Dirty'.padEnd(dirtyW) + 'Unpushed'),
  );
  for (const r of preflight.repos) {
    const branchText = (r.branch ?? '(detached)').padEnd(branchW);
    const branchCol = r.onExpectedBranch ? branchText : chalk.yellow(branchText);
    const dirtyText = (r.dirty ? `${r.changedFiles.length} file(s)` : 'clean').padEnd(dirtyW);
    const dirtyCol = r.dirty ? chalk.yellow(dirtyText) : chalk.green(dirtyText);
    const aheadText = r.ahead === null ? 'never pushed' : String(r.ahead);
    const aheadCol = r.ahead === null || (r.ahead ?? 0) > 0 ? chalk.yellow(aheadText) : chalk.green(aheadText);
    const access = r.editable ? '' : chalk.dim('  read-only reference, not finished');
    console.log('  ' + r.name.padEnd(nameW) + branchCol + dirtyCol + aheadCol + access);
  }
  console.log();

  // ── Verification policy (shared with the GUI and MCP) ─────────────────
  const policy = await evaluateProgression(workspacePath);
  for (const repo of policy.repos) {
    const mark = repo.ready ? chalk.green('✔') : chalk.red('✖');
    console.log(`  ${mark} ${repo.detail}`);
  }
  // The plan: what a milestone still waits for stops finishing; the rest only warns.
  const planBlockers = policy.blockers.slice(policy.repos.filter((repo) => !repo.ready).length);
  for (const blocker of planBlockers) console.log(`  ${chalk.red('✖')} ${blocker}`);
  for (const warning of policy.warnings) console.log(`  ${chalk.yellow('!')} ${warning}`);
  console.log();
  const override = options.overrideVerification !== undefined
    ? { reason: options.overrideVerification }
    : undefined;
  const unverified = policy.repos.some((repo) => !repo.ready);
  if (!policy.ready && !override) {
    console.log(chalk.red(`✖ Finish refused: ${[unverified && 'verification evidence is missing, failed or stale', planBlockers.length && 'a milestone still waits for open plan items'].filter(Boolean).join(', and ')}.`));
    console.log(chalk.dim(`  ${unverified ? 'Run `ctxspace verify`' : 'Handle them with `ctxspace plan`'}, or finish anyway with --override-verification "<reason>" (the reason is recorded).\n`));
    process.exitCode = 1;
    return;
  }
  if (!policy.ready && override) {
    console.log(chalk.yellow(`⚠ Finishing anyway. Recorded reason: ${override.reason}\n`));
  }

  if (options.dryRun) {
    const preview = await finishWorkspace(workspacePath, {
      message: options.message ?? 'dry run',
      createPrs: false,
      override,
      dryRun: true,
    });
    printDryRun(preview);
    return;
  }

  // ── Commit message ─────────────────────────────────────────────────────
  let message = options.message;
  const hasDirty = preflight.repos.some((r) => r.dirty && r.onExpectedBranch && r.editable);
  if (hasDirty && !message) {
    const { promptMultiLineInput } = await import('../utils/prompts.js');
    message = await promptMultiLineInput('commit message for the remaining changes');
    if (!message.trim()) {
      console.log(chalk.yellow('No commit message — leaving uncommitted changes in place.\n'));
      message = undefined;
    }
  }

  // ── Run the finish engine ────────────────────────────────────────────────
  let report: FinishReport;
  try {
    report = await finishWorkspace(workspacePath, {
      message,
      createPrs: options.pr !== false,
      override,
    });
  } catch (error) {
    console.error(chalk.red(`✖ ${error instanceof Error ? error.message : String(error)}\n`));
    process.exitCode = 1;
    return;
  }
  if (report.blocked) {
    // The evidence changed between the check above and the run.
    console.log(chalk.red('✖ Finish refused: verification evidence changed. Verify again.\n'));
    process.exitCode = 1;
    return;
  }
  if (report.resumedFrom) {
    console.log(chalk.dim(`Resuming a previous finish that ended ${report.resumedFrom === 'running' ? 'before it completed' : 'with failures'}; completed commits are not repeated.\n`));
  }

  console.log(chalk.bold('Results:'));
  for (const r of report.repos) {
    console.log(`  ${chalk.bold(r.name)}: ${describeRepo(r)}`);
  }
  console.log();

  const prLinks = report.repos.filter((r) => r.prUrl || r.compareUrl);
  if (prLinks.length > 0) {
    console.log(chalk.bold('Open a PR:'));
    for (const r of prLinks) {
      console.log(`  ${chalk.bold(r.name)}: ${chalk.cyan(r.prUrl ?? r.compareUrl)}`);
    }
    console.log();
  }

  // ── Knowledge promotion ──────────────────────────────────────────────────
  if (options.knowledge !== false && !options.yes) {
    await promoteInteractively(workspacePath);
  }

  // ── Archive or cleanup ─────────────────────────────────────────────────
  if (!report.safeToCleanup) {
    if (options.cleanup || options.archive) {
      console.log(chalk.yellow(`⚠  Not ${options.archive ? 'archiving' : 'removing'} the workspace — some repos are still dirty or unpushed:`));
      for (const r of report.repos) {
        if (r.error) console.log(`    - ${r.name}: ${r.error}`);
        else if (r.skipped) console.log(`    - ${r.name}: ${r.skipped}`);
      }
      console.log();
    }
    console.log(chalk.green('✅ Finish complete.\n'));
    return;
  }

  if (options.archive) {
    reportArchiveOutcome(await archiveWorkspace(workspacePath, { park: options.park }));
    return;
  }

  const choice: 'archive' | 'delete' | 'keep' = options.cleanup
    ? 'delete'
    : options.yes
      ? 'keep'
      : await select({
          message: 'Everything is pushed. What now?',
          default: 'keep',
          choices: [
            { name: 'Keep the workspace', value: 'keep' as const },
            { name: `Archive it — remove worktrees once merged, keep milestones, notes, knowledge and documents`, value: 'archive' as const },
            { name: 'Delete it and its record', value: 'delete' as const },
          ],
        });

  if (choice === 'archive') {
    reportArchiveOutcome(await archiveWorkspace(workspacePath, {}));
    return;
  }

  if (choice === 'delete') {
    const confirmed = !options.yes
      ? await confirm({
          message: `Delete workspace "${feature.branchName}" and its record — milestones, verification history, planning notes, knowledge (including promoted base knowledge) and documents? Worktrees are force-removed. \`${CLI_NAME} archive\` keeps the record instead.`,
          default: false,
        })
      : true;
    if (confirmed) {
      try {
        try {
          await stopServices(workspacePath);
        } catch {
          // Non-fatal if no services were running or PM2 is not active
        }
        await deleteWorkspace(workspacePath);
        console.log(chalk.green(`\n✅ Removed workspace ${feature.branchName}.\n`));
      } catch (error) {
        console.error(chalk.red(`✖ ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }
  }

  console.log(chalk.green('✅ Finish complete.\n'));
}

/** Prints the remote effects a finish would have, without changing anything. */
function printDryRun(preview: FinishReport): void {
  console.log(chalk.yellow('Dry run — no changes will be made.'));
  for (const r of preview.repos) {
    if (r.skipped) {
      console.log(`  ${chalk.bold(r.name)}: skipped (${r.skipped})`);
      continue;
    }
    const effects: string[] = [];
    if (r.wouldCommit) effects.push(`commit on ${r.branch}`);
    if (r.wouldPush) effects.push(`push ${r.branch} → ${r.remoteUrl ?? 'no remote'}`);
    if (r.compareUrl) effects.push(`PR link ${r.compareUrl}`);
    if (r.error) effects.push(chalk.red(r.error));
    console.log(`  ${chalk.bold(r.name)}: ${effects.join('; ') || 'nothing to do'}`);
  }
  console.log();
}

/** One-line description of a repo's finish outcome. */
function describeRepo(r: RepoFinishReport): string {
  if (r.error) return chalk.red(`✖ ${r.error}`);
  if (r.skipped) return chalk.yellow(`skipped (${r.skipped})`);
  const parts: string[] = [];
  if (r.committed) parts.push(`committed ${r.commitHash ?? ''}`.trim());
  if (r.pushed) parts.push('pushed');
  if (parts.length === 0) parts.push('nothing to do');
  return chalk.green(`✔ ${parts.join(', ')}`);
}

/** Interactive knowledge merge-back into per-repo base knowledge. */
async function promoteInteractively(workspacePath: string): Promise<void> {
  const content = await readWorkspaceKnowledge(workspacePath);
  if (!content) return;

  const promotable = parseKnowledgeEntries(content).filter((e) => e.type && PROMOTABLE_TYPES.includes(e.type));
  if (promotable.length === 0) return;

  const wants = await confirm({
    message: `Promote reusable learnings into repo base knowledge? (${promotable.length} available)`,
    default: false,
  });
  if (!wants) return;

  const repos = await getWorkspaceRepos(workspacePath);
  const repoName = await select({
    message: "Promote into which repository's base knowledge?",
    choices: repos.map((r) => ({ name: r.name, value: r.name })),
  });

  const indices = await checkbox({
    message: 'Select learnings to promote:',
    choices: promotable.map((e, i) => ({ name: `[${e.type}] ${oneLine(e.text)}`, value: i })),
  });
  const selected = indices.map((i) => promotable[i]);
  if (selected.length === 0) return;

  const move = await confirm({ message: 'Remove the promoted entries from the workspace knowledge file?', default: false });
  const result = await promoteKnowledge(workspacePath, { repoName, entries: selected, mode: move ? 'move' : 'copy' });
  console.log(chalk.green(`  ✔ Promoted ${result.promotedCount} learning(s) to ${repoName} base knowledge.`));
}
