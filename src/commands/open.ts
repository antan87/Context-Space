/**
 * @module commands/open
 * Re-opens an existing NexusFlow workspace in an editor.
 */

import chalk from 'chalk';
import { execa } from 'execa';
import { select, confirm, search } from '@inquirer/prompts';

import { loadConfig } from '../core/config.js';
import { listWorkspaces } from '../core/workspace.js';
import { detectEditors } from '../utils/detect-editors.js';
import { openInEditor } from '../utils/open-editor.js';
import { promptSelectEditor } from '../utils/prompts.js';
import { findSessions } from '../utils/session-finder.js';
import { CLI_NAME } from '../core/constants.js';
import { HARNESSES, isHarnessId } from '../harnesses/registry.js';

/**
 * Lets the user pick an existing workspace and open it in an editor.
 */
export async function openCommand(): Promise<void> {
  const config = await loadConfig();
  const workspaces = await listWorkspaces(config.workspacesDir);

  if (workspaces.length === 0) {
    console.log(chalk.yellow('\nNo workspaces found.'));
    console.log(chalk.dim(`  Run "${CLI_NAME} create" to create your first workspace.\n`));
    return;
  }

  console.log(chalk.bold.cyan('\n📂 Open Workspace\n'));

  // Let user pick a workspace
  const selected = await search({
    message: 'Search and select a workspace to open:',
    source: async (input) => {
      const query = (input || '').toLowerCase();
      const filtered = workspaces.filter(
        (ws) =>
          ws.branchName.toLowerCase().includes(query) ||
          ws.workspacePath.toLowerCase().includes(query)
      );
      return filtered.map((ws) => ({
        name: `${ws.branchName} ${chalk.dim(`(${ws.repos.length} repos, ${ws.assistants.join(', ')})`)}`,
        value: ws.workspacePath,
      }));
    },
  });

  // Let user pick an editor
  const detectedEditors = await detectEditors();
  const editor = await promptSelectEditor(detectedEditors);

  if (editor) {
    try {
      await openInEditor(editor.command, selected);
      console.log(chalk.green(`\n✅ Opened ${selected} in ${editor.name}\n`));
    } catch {
      console.log(chalk.yellow(`\n⚠️  Could not open editor. Navigate manually:`));
      console.log(chalk.dim(`  cd "${selected}"\n`));
    }
  } else {
    console.log(chalk.dim(`\n  To navigate: cd "${selected}"\n`));
  }

  // ── Start AI Assistant Session ──────────────────────────────────────
  const loadedFeature = workspaces.find((ws) => ws.workspacePath === selected);
  if (loadedFeature && loadedFeature.assistants.length > 0) {
    let assistant = loadedFeature.assistants[0];
    if (loadedFeature.assistants.length > 1) {
      assistant = await select({
        message: 'Which assistant would you like to run in this workspace?',
        choices: loadedFeature.assistants.map((a) => ({ name: a, value: a })),
      });
    }

    const confirmStart = await confirm({
      message: `Do you want to start a session with ${assistant} inside the workspace now?`,
      default: true,
    });

    if (confirmStart) {
      console.log(chalk.cyan(`\n🚀 Starting ${assistant} session inside workspace...\n`));

      const sessions = await findSessions(selected, loadedFeature.repos);
      const harness = isHarnessId(assistant) ? HARNESSES[assistant] : undefined;
      const cmdName = harness?.binary ?? assistant.toLowerCase();

      const matchingSessions = sessions.filter((s) => s.assistant === assistant);
      let targetSessionId: string | undefined;

      if (matchingSessions.length === 1) {
        const sessionChoice = await select({
          message: `Found 1 past ${assistant} session: "${matchingSessions[0].title}". What would you like to do?`,
          choices: [
            {
              name: `Resume session (${chalk.dim(new Date(matchingSessions[0].updatedAt).toLocaleString())})`,
              value: matchingSessions[0].id,
            },
            {
              name: 'Start a new session instead',
              value: '__new__',
            },
          ],
        });
        if (sessionChoice !== '__new__') {
          targetSessionId = sessionChoice;
        }
      } else if (matchingSessions.length > 1) {
        const sessionChoice = await select({
          message: `Found ${matchingSessions.length} past ${assistant} sessions. Which one would you like to resume?`,
          choices: [
            ...matchingSessions.map((s) => ({
              name: `${s.title} (${chalk.dim(new Date(s.updatedAt).toLocaleString())})`,
              value: s.id,
            })),
            {
              name: 'Start a new session instead',
              value: '__new__',
            },
          ],
        });
        if (sessionChoice !== '__new__') {
          targetSessionId = sessionChoice;
        }
      }

      // No existing session for this assistant (or user chose new session): start fresh
      const cmdArgs = targetSessionId ? harness?.resumeArgs(targetSessionId) ?? [] : [];

      try {
        const result = await execa(cmdName, cmdArgs, {
          cwd: selected,
          stdio: 'inherit',
          shell: process.platform === 'win32',
          reject: false,
        });
        if (result.exitCode === 0 || result.exitCode === 130 || result.exitCode === null) {
          console.log(chalk.green(`\n👋 Exited ${assistant} session.`));
        } else {
          console.log(chalk.yellow(`\n⚠️  ${assistant} exited with code ${result.exitCode}.`));
        }
      } catch {
        const fullCmd = [cmdName, ...cmdArgs].join(' ');
        console.log(
          chalk.yellow(`\n⚠️  Could not start ${assistant}. Please start it manually:\n  ${chalk.dim(`cd "${selected}" && ${fullCmd}`)}`)
        );
      }
    }
  }
}
