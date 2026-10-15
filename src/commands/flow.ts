/**
 * @module commands/flow
 * CLI command `ctxspace flow` — visualizes active lifecycle steps,
 * milestone gates, and multi-branch sister fleets in the terminal.
 */

import chalk from 'chalk';
import { getWorkContext } from '../core/work-guidance.js';
import { loadWorkspaceLifecycle, advanceLifecycleStep, renderLifecyclePlan } from '../core/lifecycle.js';
import { resolveWorkspaceInteractive } from '../utils/resolve-workspace.js';
import { BRAND_NAME } from '../core/constants.js';
import { resolvePlanActor } from './plan.js';

export interface FlowCommandOptions {
  step?: string;
  action?: 'start' | 'verify' | 'complete';
  json?: boolean;
  assignment?: boolean;
}

export async function flowCommand(
  workspaceArg: string | undefined,
  options: FlowCommandOptions = {},
): Promise<void> {
  const workspacePath = await resolveWorkspaceInteractive(workspaceArg, 'Select a workspace to view flow:');
  if (!workspacePath) return;

  if (options.assignment) {
    await loadWorkspaceLifecycle(workspacePath);
    const context = await getWorkContext(workspacePath);
    console.log(options.json ? JSON.stringify(context, null, 2)
      : context.assignment + (context.lifecycle ? '\n' + renderLifecyclePlan(context.lifecycle) : ''));
    return;
  }

  if (options.step && options.action) {
    console.log(chalk.cyan(`\nAdvancing step "${options.step}" (${options.action})...`));
    // Recorded as the AI, by its tool's name, as `ctxspace plan` records it; never as the user by default.
    const actor = resolvePlanActor({}, process.env, Boolean(process.stdin.isTTY && process.stdout.isTTY));
    const updated = await advanceLifecycleStep(workspacePath, options.step, options.action, actor);
    console.log(chalk.green(`✔ Step transitioned successfully.\n`));
    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
  }

  const lifecycle = await loadWorkspaceLifecycle(workspacePath);

  if (options.json) {
    console.log(JSON.stringify(lifecycle, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`\n🌊 ${BRAND_NAME} — Active Lifecycle & Fleet Radar\n`));
  console.log(
    `Workspace: ${chalk.bold(lifecycle.workspaceId)}${lifecycle.currentStepId ? `  •  Active milestone: ${chalk.green(lifecycle.currentStepId)}` : ''}\n`,
  );

  if (lifecycle.steps.length) {
    console.log(chalk.bold('📍 Lifecycle Milestone Pipeline:'));
    console.log(chalk.dim('─'.repeat(72)));

    lifecycle.steps.forEach((step, idx) => {
      let badge = '';
      switch (step.status) {
        case 'completed':
          badge = chalk.green('✔ COMPLETED');
          break;
        case 'verified':
          badge = chalk.cyan('🛡 VERIFIED');
          break;
        case 'in_progress':
          badge = chalk.bgCyan.black.bold(' 🔄 ACTIVE ');
          break;
        case 'pending':
          badge = chalk.yellow('⏳ PENDING');
          break;
        case 'blocked':
          badge = chalk.dim('🔒 BLOCKED');
          break;
      }

      const prefix = idx === lifecycle.steps.length - 1 ? '└─' : '├─';
      const depNotice = step.dependsOn && step.dependsOn.length > 0 ? chalk.dim(` [depends on: ${step.dependsOn.join(', ')}]`) : '';
      const ownerNotice = step.owner ? chalk.dim(` (${step.owner})`) : '';
      const branchNotice = step.branch ? chalk.cyan(` [${step.branch}]`) : '';

      console.log(`${prefix} ${badge}  ${chalk.bold(step.title)}${ownerNotice}${branchNotice}${depNotice}`);
      if (step.description) {
        console.log(`│    ${chalk.dim(step.description)}`);
      }
      if (step.lastVerificationStatus) {
        const vStatus = step.lastVerificationStatus === 'pass' ? chalk.green('PASS') : chalk.red('FAIL');
        const shaStr = step.lastVerificationSha ? ` @ ${step.lastVerificationSha.slice(0, 7)}` : '';
        console.log(`│    ${chalk.dim(`Gate:`)} ${vStatus}${chalk.dim(shaStr)}`);
      }
      if (idx < lifecycle.steps.length - 1) {
        console.log('│');
      }
    });
    console.log(chalk.dim('─'.repeat(72)));
  }

  if (lifecycle.fleet && lifecycle.fleet.length > 0) {
    console.log(chalk.bold('\n🛰️  Sister Branch Fleet & Collaborator Radar:'));
    for (const member of lifecycle.fleet) {
      const dot = member.isCurrent ? chalk.green('●') : chalk.cyan('○');
      const branchName = member.isCurrent ? chalk.bold(member.branch) : member.branch;
      const aheadBehind = `+${member.ahead} / -${member.behind}`;
      const author = member.lastCommitAuthor ? ` • ${member.lastCommitAuthor}` : '';
      const date = member.lastCommitDate ? ` (${member.lastCommitDate})` : '';
      const msg = member.lastCommitMessage ? chalk.dim(` "${member.lastCommitMessage}"`) : '';

      console.log(`  ${dot} ${branchName.padEnd(28)} ${chalk.dim(aheadBehind.padEnd(12))}${author}${date}${msg}`);
    }
  }
  console.log();
}
