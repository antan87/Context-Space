import chalk from 'chalk';

import { resolveWorkspaceInteractive } from '../utils/resolve-workspace.js';
import {
  addWorkspaceRemote,
  pullWorkspaceArtifacts,
  pushWorkspaceArtifacts,
} from '../core/workspace-git.js';

async function workspace(workspaceArg: string | undefined): Promise<string | null> {
  return resolveWorkspaceInteractive(workspaceArg, 'Select a workspace artifact repository:');
}

export async function remoteAddCommand(url: string, workspaceArg?: string): Promise<void> {
  const workspacePath = await workspace(workspaceArg);
  if (!workspacePath) return;
  await addWorkspaceRemote(workspacePath, url);
  console.log(chalk.green('✔ Added workspace artifact remote origin.'));
}

export async function remotePushCommand(workspaceArg?: string): Promise<void> {
  const workspacePath = await workspace(workspaceArg);
  if (!workspacePath) return;
  await pushWorkspaceArtifacts(workspacePath);
  console.log(chalk.green('✔ Pushed workspace artifact history.'));
}

export async function remotePullCommand(workspaceArg?: string): Promise<void> {
  const workspacePath = await workspace(workspaceArg);
  if (!workspacePath) return;
  const result = await pullWorkspaceArtifacts(workspacePath);
  if (result.status === 'draft') {
    console.log(chalk.yellow(result.pending
      ? `Saved the incoming database snapshot as draft ${result.digest}. Review it with ctxspace plan import. Your Git branch and working files stayed as they were.`
      : `The incoming snapshot draft ${result.digest} was already handled. Reconcile the Git branches before pushing. Keep the approved workspace exports if Git asks you to resolve them.`));
    return;
  }
  console.log(chalk.green('✔ Pulled workspace artifact history with rebase.'));
}
