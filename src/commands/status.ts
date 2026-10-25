/**
 * @module commands/status
 * Shows the status of all services in a workspace.
 */

import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { loadConfig } from '../core/config.js';
import { listWorkspaces, loadFeatureConfig } from '../core/workspace.js';
import { getServiceStatus, loadRunningState } from '../orchestration/index.js';
import { getWorkspaceStatusReport } from '../core/status.js';
import { checkGenerationLock } from '../core/generation-lock.js';
import { getLastVerificationReport } from '../core/workspace-state.js';
import { BRAND_NAME } from '../core/constants.js';
import { findSessions } from '../utils/session-finder.js';

/**
 * Shows status of running services for a workspace.
 *
 * @param workspaceArg - Optional workspace path from CLI.
 * @param options      - Command options including --json.
 */
export async function statusCommand(workspaceArg?: string, options?: { json?: boolean }): Promise<void> {
  const workspacePath = await resolveWorkspace(workspaceArg);
  if (!workspacePath) return;

  if (options?.json) {
    // Preserve the established machine-readable contract. Repository and
    // generated-context detail is additive in the human view below; changing
    // this top-level JSON shape would break existing scripts.
    const runningState = await loadRunningState(workspacePath);
    console.log(JSON.stringify(runningState, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`\n📊 ${BRAND_NAME} — Live Workspace Status\n`));
  const repositories = await getWorkspaceStatusReport(workspacePath);
  console.log(chalk.bold('Repositories:'));
  for (const repo of repositories.repos) {
    console.log(`  ${repo.name}: ${repo.branch ?? 'detached'} @ ${repo.headSha?.slice(0, 12) ?? 'unknown'}; ${repo.dirty ? 'dirty' : 'clean'}; ${repo.ahead === null ? 'not pushed' : `${repo.ahead} ahead / ${repo.behind} behind`}`);
    if (repo.collisionWarning) {
      console.log(chalk.yellow(`    ⚠ ${repo.collisionWarning}`));
    }
  }
  const freshness = await checkGenerationLock(workspacePath);
  console.log(`\n${freshness.fresh ? chalk.green('Generated context: fresh') : chalk.red(`Generated context: stale/drifted (${freshness.drift.length})`)}`);

  const verification = await getLastVerificationReport(workspacePath);
  if (verification) {
    const statusColor =
      verification.overallStatus === 'pass'
        ? chalk.green
        : verification.overallStatus === 'pass_dirty'
        ? chalk.yellow
        : chalk.red;
    const timeAgo = Math.max(0, Math.round((Date.now() - new Date(verification.verifiedAt).getTime()) / 60000));
    console.log(statusColor(`Verification Gate: ${verification.overallStatus.toUpperCase()} (${timeAgo === 0 ? 'just now' : `${timeAgo}m ago`}, ${verification.repos.length} repo(s))`));
  } else {
    console.log(chalk.dim('Verification Gate: not run yet (run `ctxspace verify`)'));
  }

  console.log(chalk.bold('\nAI Assistant Sessions:'));
  try {
    const sessions = await findSessions(
      workspacePath,
      repositories.repos.map((r) => r.path),
    );
    if (!sessions || sessions.length === 0) {
      console.log('  No active AI sessions found.');
    } else {
      for (const sess of sessions.slice(0, 5)) {
        const provider = sess.assistant.endsWith('-cli') ? sess.assistant : `${sess.assistant}-cli`;
        const input = sess.usage?.inputTokens ?? 0;
        const output = sess.usage?.outputTokens ?? 0;
        const cacheStr =
          typeof sess.usage?.cachedInputTokens === 'number' && sess.usage.cachedInputTokens > 0
            ? ` (${sess.usage.cachedInputTokens.toLocaleString()} cached)`
            : '';
        let quotaStatus: string | undefined;
        if (sess.quota) {
          const quotaObj = sess.quota as Record<string, unknown>;
          quotaStatus =
            sess.quota.tokens?.status ??
            sess.quota.requests?.status ??
            (typeof quotaObj.status === 'string' ? quotaObj.status : undefined) ??
            sess.quota.planType ??
            (sess.quota.label ? sess.quota.label.toLowerCase().replace(/\s+/g, '_') : 'ok');
        }
        const quotaStr = quotaStatus ? ` | Quota: ${quotaStatus}` : '';
        const costStr =
          typeof sess.usage?.costUsdEstimate === 'number'
            ? ` | ~$${sess.usage.costUsdEstimate.toFixed(3)}`
            : '';
        console.log(`  [${provider}] ${sess.id}: ${input.toLocaleString()} in / ${output.toLocaleString()} out${cacheStr}${quotaStr}${costStr}`);
      }
    }
  } catch {
    console.log('  No active AI sessions found.');
  }

  console.log(chalk.bold('\nServices:'));
  await getServiceStatus(workspacePath);
  console.log();
}

/**
 * Resolves a workspace path from argument, cwd, or user prompt.
 */
async function resolveWorkspace(workspaceArg?: string): Promise<string | null> {
  if (workspaceArg) return workspaceArg;

  const cwdFeature = await loadFeatureConfig(process.cwd());
  if (cwdFeature) return cwdFeature.workspacePath;

  const config = await loadConfig();
  const workspaces = await listWorkspaces(config.workspacesDir);

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspaces found.\n'));
    return null;
  }

  const selected = await select({
    message: 'Select a workspace:',
    choices: workspaces.map((ws) => ({
      name: `${ws.branchName} ${chalk.dim(`(${ws.repos.length} repos)`)}`,
      value: ws.workspacePath,
    })),
  });

  return selected;
}
