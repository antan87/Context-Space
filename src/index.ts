#!/usr/bin/env node

/**
 * @module index
 * NexusFlow CLI entry point.
 *
 * Combines multiple repositories into a workspace with rich AI assistant
 * context files so tools like Claude, Codex, Copilot, and Cursor understand
 * your entire project.
 */

import { Command } from 'commander';
import chalk from 'chalk';

import { createCommand } from './commands/create.js';
import { listCommand } from './commands/list.js';
import { openCommand } from './commands/open.js';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { logsCommand } from './commands/logs.js';
import { statusCommand } from './commands/status.js';
import { verifyCommand } from './commands/verify.js';
import { flowCommand } from './commands/flow.js';
import { registerPlanCommand } from './commands/plan.js';
import { runsInsideAiTool } from './utils/ai-tool.js';
import { uiCommand } from './commands/ui.js';
import { tuiCommand } from './commands/tui.js';
import { syncCommand } from './commands/sync.js';
import { commitCommand } from './commands/commit.js';
import { diffCommand } from './commands/diff.js';
import { removeCommand } from './commands/remove.js';
import { archiveCommand, unarchiveCommand } from './commands/archive.js';
import { loadConfig } from './core/config.js';
import { debugLog } from './utils/debug.js';
import { loadPlugins } from './core/plugins/loader.js';
import { addRepoCommand } from './commands/add-repo.js';
import { isolateCommand } from './commands/isolate.js';
import { mcpRunCommand, mcpSetupCommand } from './commands/mcp.js';
import { handoffCommand } from './commands/handoff.js';
import { tagListCommand, tagAddCommand, tagRemoveCommand, tagShowCommand } from './commands/tag.js';
import { skillListCommand, skillLintCommand, skillCreateCommand, skillDeleteCommand, skillShowCommand } from './commands/skill.js';
import { refreshCommand } from './commands/refresh.js';
import { progressCommand } from './commands/progress.js';
import { remoteAddCommand, remotePullCommand, remotePushCommand } from './commands/remote.js';
import { doctorCommand } from './commands/doctor.js';
import { dataGuideCommand, diagnosticPreviewCommand, diagnosticExportCommand } from './commands/diagnostics.js';
import { knowledgeAddCommand, knowledgeShowCommand, knowledgePromoteCommand } from './commands/knowledge.js';
import { strategyListCommand, strategyCreateCommand, strategyEditCommand, strategyDeleteCommand, strategyShowCommand } from './commands/strategy.js';
import { projectListCommand, projectAddCommand, projectShowCommand, projectRemoveCommand } from './commands/project.js';
import { finishCommand } from './commands/finish.js';
import { desktopCommand, desktopInstallCommand } from './commands/desktop.js';
import { configShowCommand, configGetCommand, configSetCommand } from './commands/config.js';
import {
  scheduleAddCommand,
  scheduleListCommand,
  scheduleRemoveCommand,
  scheduleRunCommand,
  scheduleToggleCommand,
} from './commands/schedule.js';
import { adapterListCommand, adapterUseCommand, adapterInfoCommand, adapterInitCommand } from './commands/adapter.js';
import { getCurrentVersion, checkForUpdates, printUpdateBanner } from './utils/update-check.js';
import { BRAND_NAME, BRAND_TAGLINE, CLI_NAME, CLI_ALIASES } from './core/constants.js';

const program = new Command();

program
  .name(CLI_NAME)
  .description(
    `${BRAND_NAME} — Combine multiple repos into a workspace with rich AI assistant context`,
  )
  .version(getCurrentVersion())
  .option('--debug', 'Enable verbose debug logging to stderr (or set CONTEXTSPACE_DEBUG=1)')
  .addHelpText('beforeAll', () => {
    const c1 = chalk.hex('#FDE047');
    const c2 = chalk.hex('#FB923C');
    const c3 = chalk.hex('#F43F5E');
    const c4 = chalk.hex('#6366F1');

    return `
${c1('   ___           __           __   ____')}
${c2('  / __\\___  _ __/ /____ __ __/ /_ / __/___  ___ ________')}
${c3(' / /  / _ \\/ _  / __/ // /\\ \\ / __/ \\_ \\/ _ \\/ _ `/ __/ -_)')}
${c4(' \\___/\\___/_//_/\\__/\\_,_//_\\_\\\\__/ /___/ .__/\\_,_/\\__/\\__/')}
${c4('                                      /_/')}
  ${chalk.bold(BRAND_NAME)} ${chalk.dim(`v${getCurrentVersion()}`)} — ${chalk.hex('#FB923C')(BRAND_TAGLINE)}
  Aliases: ${chalk.dim(CLI_ALIASES.join(', '))}
`;
  });

// Turn the global --debug flag into the env var the debug logger reads, before
// any action runs.
program.hook('preAction', (thisCommand) => {
  if (thisCommand.opts().debug) {
    process.env.CONTEXTSPACE_DEBUG = '1';
    process.env.NEXUSFLOW_DEBUG = '1';
  }
});

function isDebugMode(): boolean {
  return process.argv.includes('--debug') || Boolean(process.env.CONTEXTSPACE_DEBUG || process.env.NEXUSFLOW_DEBUG);
}

/**
 * Wraps a command action: clean exit on prompt cancellation (Ctrl+C inside an
 * inquirer prompt), clean red error message by default, and exit code 1.
 * When --debug is provided, prints the full error stack.
 */
function runAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error instanceof Error && error.message.includes('User force closed')) {
        console.log('\nCancelled.');
        process.exit(0);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\n✖ ${message}`));
      if (isDebugMode() && error instanceof Error && error.stack) {
        console.error(chalk.dim(error.stack));
      } else if (!isDebugMode()) {
        console.error(chalk.dim('  (Run with --debug for details)\n'));
      }
      process.exit(1);
    }
  };
}

program
  .command('create')
  .description(
    'Create a new feature workspace — pick repos, pick AI assistants, generate context',
  )
  .option('-q, --quick', 'Fast-track flow for quick bug fixes or small tweaks (in-place, solo-developer)')
  .option('--flow <type>', 'Development flow preset: quick-fix, feature, or epic')
  .option('-m, --mode <mode>', 'Workspace mode: worktree or in-place')
  .option('-s, --strategy <strategy>', 'Teamwork strategy ID')
  .option('-t, --tag <tags...>', 'Category or domain tags to attach (mounts associated skill bundles)')
  .option('--org <orgId>', 'Organization profile to inherit company standards from')
  .action(runAction(createCommand));

program
  .command('quick')
  .description('Quick-fix fast lane — start a localized bug fix or tweak with minimal ceremony')
  .option('-m, --mode <mode>', 'Workspace mode: in-place (default) or worktree', 'in-place')
  .option('-t, --tag <tags...>', 'Category or domain tags to attach (mounts associated skill bundles)')
  .option('--org <orgId>', 'Organization profile to inherit company standards from')
  .action(runAction((options: any) => createCommand({ quick: true, ...options })));

program
  .command('list')
  .alias('ls')
  .description('List workspaces (archived ones are hidden unless asked for)')
  .option('--json', 'Output as JSON')
  .option('--archived', 'List only archived workspaces')
  .option('--all', 'List active and archived workspaces')
  .action(runAction(listCommand));

program
  .command('open')
  .description('Re-open an existing workspace in an editor')
  .action(runAction(openCommand));

program
  .command('init')
  .description(`Initialize ${BRAND_NAME} configuration`)
  .option('--workspace [path]', 'Initialize or adopt a git-backed workspace artifact repository')
  .action(runAction(async (options: { workspace?: string | boolean }) => initCommand(options)));

program
  .command('start')
  .description('Start all services in a workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => {
    await startCommand(workspace);
  }));

program
  .command('stop')
  .description('Stop all running services in a workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => {
    await stopCommand(workspace);
  }));

program
  .command('logs')
  .description('Show logs from running services')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-n, --lines <number>', 'Number of lines per service', '30')
  .action(runAction(async (workspace: string | undefined, options: { lines: string }) => {
    await logsCommand(workspace, parseInt(options.lines, 10));
  }));

program
  .command('status')
  .description('Show status of running services')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: { json?: boolean }) => {
    await statusCommand(workspace, options);
  }));

program
  .command('verify')
  .alias('test')
  .description('Run mechanical verification gates across workspace repositories')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-r, --repo <name>', 'Verify a specific repository only')
  .option('-t, --tag <name>', 'Run verification gate for a specific category or tag pack')
  .option('-f, --filter <pattern>', 'Filter pattern passed to underlying test runner')
  .option('-c, --command <cmd>', 'Override verification command to execute')
  .option('--timeout <seconds>', 'Watchdog timeout per test run in seconds', '300')
  .option('--allow-dirty', 'Permit progress even if working tree has uncommitted edits')
  .option('--json', 'Output report in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any) => {
    await verifyCommand(workspace, options);
  }));

program
  .command('flow')
  .alias('fleet')
  .description('Visualize lifecycle milestone pipeline, step progress, and sister branch fleet')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--step <id>', 'Target a specific lifecycle step ID')
  .option('--assignment', 'Read the current AI assignment, source documents, and milestone plan')
  .option('--action <action>', 'Transition action: start, verify, or complete')
  .option('--json', 'Output lifecycle in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any) => {
    await flowCommand(workspace, options);
  }));

// The plan, one item at a time: what AI tools run in their shell and people read in the Plan tab.
registerPlanCommand(program, (error) => runAction(async () => { throw error; })());

program
  .command('progress')
  .description('Show implementation progress derived from live git and available PR state')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: { json?: boolean }) => {
    await progressCommand(workspace, options);
  }));

program
  .command('ui')
  .description(`Start the ${BRAND_NAME} dashboard server (the backend the desktop app embeds)`)
  .option('-p, --port <number>', 'Port to run the dashboard server on', '3000')
  .option('-d, --daemon', 'Run the dashboard server in the background (daemon mode)')
  .option('--open', 'Also open the dashboard in your default browser')
  .option('--server-only', '(deprecated — server-only is now the default)')
  .option('--strict-port', 'Fail instead of auto-incrementing when the port is in use')
  .action(runAction(async (options: { port?: string; daemon?: boolean; serverOnly?: boolean; strictPort?: boolean; open?: boolean }) => {
    await uiCommand(options);
  }));

program
  .command('dashboard')
  .alias('dash')
  .description('Open the web dashboard in your default browser')
  .option('-p, --port <number>', 'Port to run the dashboard server on', '3000')
  .action(runAction(async (options: { port?: string }) => {
    await uiCommand({ ...options, daemon: true, open: true });
  }));

program
  .command('tui')
  .description('Open the interactive terminal GUI (TUI) dashboard')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => {
    await tuiCommand({ workspace });
  }));

program
  .command('sync')
  .description('Sync all repositories in a workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => {
    await syncCommand(workspace);
  }));

program
  .command('commit')
  .description('Commit changes across all repositories in a workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .requiredOption('-m, --message <msg>', 'Commit message')
  .option('--no-push', 'Stage and commit changes without pushing to remote')
  .option('--dry-run', 'Preview changes without committing')
  .option('-r, --repo <repos...>', 'Only commit the given repositories (by name)')
  .action(runAction(async (workspace: string | undefined, options: { message: string; push?: boolean; dryRun?: boolean; repo?: string[] }) => {
    await commitCommand(options.message, workspace, options);
  }));

program
  .command('diff')
  .description('Display a unified summary of changes across all repositories (including unpushed commits)')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-r, --repo <repos...>', 'Only show the given repositories (by name)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: { repo?: string[]; json?: boolean }) => {
    await diffCommand(workspace, options);
  }));
const tagCmd = program
  .command('tag')
  .alias('category')
  .description('Inspect and manage enterprise categories, verticals, and traits');

tagCmd
  .command('list')
  .alias('ls')
  .description('List all available categories, vertical subsystems, and horizontal traits')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any) => {
    await tagListCommand(workspace, options);
  }));

tagCmd
  .command('add <id>')
  .description('Attach a category or trait tag to the workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (id: string, workspace: string | undefined) => {
    await tagAddCommand(id, workspace);
  }));

tagCmd
  .command('remove <id>')
  .alias('rm')
  .description('Detach a category or trait tag from the workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (id: string, workspace: string | undefined) => {
    await tagRemoveCommand(id, workspace);
  }));

tagCmd
  .command('show <id>')
  .description('Show details, parent tree, microservices, and rules for a category or trait')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (id: string, options: any, cmd: any) => {
    const merged = cmd?.optsWithGlobals ? { ...cmd.optsWithGlobals(), ...options } : options;
    await tagShowCommand(id, merged);
  }));

// Default action for `ctxspace tag` without subcommands runs `tag list`
tagCmd
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any, cmd: any) => {
    const merged = cmd?.optsWithGlobals ? { ...cmd.optsWithGlobals(), ...options } : options;
    await tagListCommand(workspace, merged);
  }));

function resolveCliOptions(cmd: any, options: any): any {
  const result: Record<string, any> = { ...options };
  if (!cmd) return result;
  const parent = cmd.parent;
  if (parent) {
    for (const [key, val] of Object.entries(parent.opts() || {})) {
      if (parent.getOptionValueSource?.(key) === 'cli') {
        result[key] = val;
      }
    }
  }
  for (const [key, val] of Object.entries(cmd.opts() || {})) {
    if (cmd.getOptionValueSource?.(key) === 'cli') {
      result[key] = val;
    }
  }
  return result;
}

const skillCmd = program
  .command('skill')
  .alias('skills')
  .description('Manage agent skills (workspace-local and global company standards)');

skillCmd
  .command('lint')
  .description('Check that every skill loads, and say what to fix for those that do not')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--strict', 'Also fail when a skill loads but has something to review')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillLintCommand(workspace, merged);
  }));

skillCmd
  .command('list')
  .alias('ls')
  .description('List agent skills in current workspace and global catalog')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--scope <scope>', 'Filter by scope: workspace, global, or all', 'all')
  .option('-t, --tag <tags...>', 'Filter skills by tags')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillListCommand(workspace, merged);
  }));

skillCmd
  .command('create')
  .description('Create a new agent skill (workspace-local or global)')
  .argument('<id>', 'Skill identifier (e.g. commit-rules or vat-calc)')
  .argument('[workspace]', 'Path to workspace (required if workspace scope)')
  .option('--title <title>', 'Human-readable title')
  .option('-d, --description <desc>', 'Skill description')
  .option('-c, --content <content>', 'Markdown content/instructions for the skill')
  .option('-f, --file <path>', 'File path to read skill markdown instructions from')
  .option('-t, --tag <tags...>', 'Tags to attach to the skill')
  .option('--scope <scope>', 'Skill scope: workspace (local) or global', 'workspace')
  .action(runAction(async (id: string, workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillCreateCommand(id, workspace, merged);
  }));

skillCmd
  .command('show')
  .alias('info')
  .description('Show instructions, metadata, and references for an agent skill')
  .argument('<id>', 'Skill identifier to inspect')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (id: string, workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillShowCommand(id, workspace, merged);
  }));

skillCmd
  .command('delete')
  .alias('rm')
  .description('Delete an agent skill')
  .argument('<id>', 'Skill identifier to remove')
  .argument('[workspace]', 'Path to workspace')
  .option('--scope <scope>', 'Scope to delete from: workspace or global')
  .action(runAction(async (id: string, workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillDeleteCommand(id, workspace, merged);
  }));

// Default action for `ctxspace skill` without subcommands runs `skill list`
skillCmd
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('--scope <scope>', 'Filter by scope: workspace, global, or all', 'all')
  .option('-t, --tag <tags...>', 'Filter skills by tags')
  .option('--json', 'Output in JSON format')
  .action(runAction(async (workspace: string | undefined, options: any, cmd: any) => {
    const merged = resolveCliOptions(cmd, options);
    await skillListCommand(workspace, merged);
  }));

program
  .command('remove')
  .alias('rm')
  .description('Delete a workspace and its record (force-removes its worktrees); consider archive instead')
  .argument('[workspace]', 'Workspace name or path')
  .action(runAction(async (workspace?: string) => {
    await removeCommand(workspace);
  }));

program
  .command('archive')
  .description('Complete a workspace: remove its worktrees once their work is merged, keep its record')
  .argument('[workspace]', 'Workspace name or path (auto-detects from CWD)')
  .option('--park', 'Also archive pushed-but-unmerged work; its branch is kept')
  .option('--keep-branches', 'Keep every branch, even merged ones this workspace created')
  .option('--delete-remote-branches', 'Also delete merged branches on origin (only while they still point at the merged commit)')
  .option('--dry-run', 'Show what would be removed and kept without changing anything')
  .option('-y, --yes', 'Do not ask for confirmation')
  .option('--json', 'Output the archive report as JSON')
  .action(runAction(async (workspace: string | undefined, options: { park?: boolean; keepBranches?: boolean; deleteRemoteBranches?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
    await archiveCommand(workspace, options);
  }));

program
  .command('unarchive')
  .description('Restore an archived workspace as active (its repositories stay read-only references)')
  .argument('[workspace]', 'Workspace name or path')
  .option('--json', 'Output the result as JSON')
  .action(runAction(async (workspace: string | undefined, options: { json?: boolean }) => {
    await unarchiveCommand(workspace, options);
  }));

program
  .command('add-repo')
  .alias('add')
  .description('Add a repository to an existing workspace and update configurations')
  .argument('[repo-path]', 'Path to the repository to add')
  .argument('[workspace]', 'Workspace name or path')
  .action(runAction(async (repoPath?: string, workspace?: string) => {
    await addRepoCommand(repoPath, workspace);
  }));

program
  .command('isolate')
  .description('Prepare a read-only reference repository for editing in its own worktree and branch')
  .argument('[repo]', 'Name or path of the repository to isolate')
  .argument('[branch]', 'Target feature branch name')
  .option('-b, --branch <branch>', 'Target feature branch name')
  .option('--base <base>', 'Base branch to branch off')
  .option('-w, --workspace <workspace>', 'Workspace name or path')
  .option('--dry-run', 'Show the path, branch and base without creating anything')
  .action(runAction(async (repo?: string, branchArg?: string, options?: { branch?: string; base?: string; workspace?: string; dryRun?: boolean }) => {
    await isolateCommand(repo, branchArg, options);
  }));

program
  .command('handoff [workspace]')
  .description('Generate a compact handoff bundle (contextspace-handoff.md) for session resumption')
  .action(runAction(handoffCommand));


program
  .command('refresh')
  .description('Refresh workspace context, plan and handoff files (re-analyzes only changed repos)')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-f, --force', 'Ignore the analysis cache and re-analyze every repository')
  .option('--check', 'Check provenance and generated-view hashes without regenerating')
  .option('-s, --strategy <id>', 'Update the teamwork strategy (use template ID, or "auto" for AI suggestion)')
  .action(runAction(async (workspace: string | undefined, options: { force?: boolean; strategy?: string; check?: boolean }) => {
    await refreshCommand(options, workspace);
  }));

program
  .command('doctor')
  .description('Run diagnostics to verify workspace health and check for local loop issues')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => {
    await doctorCommand(workspace);
  }));

program.command('data')
  .description('Explain data storage, sharing, retention and deletion')
  .option('--json', 'Include effective local profile locations as JSON (private; not a support report)')
  .action(runAction(dataGuideCommand));

const diagnostics = program.command('diagnostics').description('Review and save a local support report without private content');
diagnostics.command('preview').argument('[workspace]', 'Workspace path or name (defaults to current workspace, otherwise runtime only)')
  .option('--candidate <file>', 'Save the sanitized candidate to a NEW file for review and later export')
  .option('--omit <sections...>', 'Exclude sections: runtime, workspace, checks')
  .action(runAction(diagnosticPreviewCommand));
diagnostics.command('export').argument('<candidate>', 'Previously saved diagnostic candidate')
  .requiredOption('--digest <sha256>', 'Digest from the reviewed preview')
  .requiredOption('--output <file>', 'NEW destination file; existing files are never replaced')
  .action(runAction(diagnosticExportCommand));

program
  .command('migrate')
  .description('Migrate legacy NexusFlow workspaces and global config to ContextSpace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-a, --all', 'Scan and migrate all workspaces found in workspacesDir')
  .option('-g, --global', 'Migrate global configuration (~/.nexusflow -> ~/.contextspace)')
  .option('--dry-run', 'Preview changes without modifying disk')
  .option('--no-refresh', 'Skip regenerating context files after migration')
  .action(runAction(async (workspace: string | undefined, options: { all?: boolean; global?: boolean; dryRun?: boolean; refresh?: boolean }) => {
    const { migrateCommand } = await import('./commands/migrate.js');
    await migrateCommand(workspace, options);
  }));

program
  .command('finish')
  .description('Finish a feature — commit & push everything, open PRs, promote learnings, optionally remove the workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-m, --message <msg>', 'Commit message for any remaining changes')
  .option('--no-pr', 'Skip PR creation and compare links')
  .option('--no-knowledge', 'Skip the knowledge promotion step')
  .option('--archive', 'Archive the workspace afterwards: remove its worktrees, keep its record')
  .option('--park', 'With --archive: also archive pushed-but-unmerged work, keeping its branch')
  .option('--cleanup', 'Delete the workspace and its record after everything is confirmed pushed (asks for confirmation)')
  .option('-y, --yes', 'Accept defaults for non-destructive prompts')
  .option('--dry-run', 'Show what finish would do without changing anything')
  .option('--override-verification <reason>', 'Finish although verification is missing, failed or stale; the reason is recorded')
  .action(runAction(async (workspace: string | undefined, options: { message?: string; pr?: boolean; knowledge?: boolean; archive?: boolean; park?: boolean; cleanup?: boolean; yes?: boolean; dryRun?: boolean; overrideVerification?: string }) => {
    await finishCommand(workspace, options);
  }));

// Knowledge command group
const knowledgeCmd = program
  .command('knowledge')
  .alias('know')
  .description('Capture and manage workspace learnings (decisions, gotchas, assumptions, questions)');

knowledgeCmd
  .command('add')
  .description('Append a timestamped learning to the workspace knowledge file')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .requiredOption('-t, --type <type>', 'Entry type: decision | gotcha | assumption | question')
  .requiredOption('-m, --message <msg>', 'The learning to record, as a rule plus its reason (max 300 chars)')
  .requiredOption('--title <title>', 'Short title used to create the searchable heading slug (max 60 chars)')
  .option('--scope <scope>', 'Applicability: repo:<name>, path:<repo/path>, or seam:<name>')
  .option('--evidence <evidence>', 'Short evidence pointer such as a commit SHA or repro document')
  .option('-r, --repo <repo>', "Write to this repo's persistent base knowledge instead")
  .action(runAction(async (workspace: string | undefined, options: { type: string; message: string; title: string; scope?: string; evidence?: string; repo?: string }) => {
    await knowledgeAddCommand(workspace, options);
  }));

program
  .command('remember')
  .description('Record and auto-commit a titled workspace learning')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .requiredOption('-t, --type <type>', 'Entry type: decision | gotcha | assumption | question')
  .requiredOption('-m, --message <msg>', 'The learning to record, as a rule plus its reason (max 300 chars)')
  .requiredOption('--title <title>', 'Short title used to create the searchable heading slug (max 60 chars)')
  .option('--scope <scope>', 'Applicability: repo:<name>, path:<repo/path>, or seam:<name>')
  .option('--evidence <evidence>', 'Short evidence pointer such as a commit SHA or repro document')
  .action(runAction(async (workspace: string | undefined, options: { type: string; message: string; title: string; scope?: string; evidence?: string }) => {
    await knowledgeAddCommand(workspace, options);
  }));

const remoteCmd = program
  .command('remote')
  .description('Manage the workspace artifact repository remote (never child repo remotes)');

remoteCmd
  .command('add')
  .argument('<url>', 'Git remote URL')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (url: string, workspace?: string) => remoteAddCommand(url, workspace)));

remoteCmd
  .command('push')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => remotePushCommand(workspace)));

remoteCmd
  .command('pull')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .action(runAction(async (workspace?: string) => remotePullCommand(workspace)));

knowledgeCmd
  .command('show')
  .description("Print the workspace knowledge file (or a repo's base knowledge)")
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-s, --section <name>', 'Only show one section')
  .option('--scope <scope>', 'Only show entries for an exact scope')
  .option('-r, --repo <repo>', "Show the repo's base knowledge file instead")
  .action(runAction(async (workspace: string | undefined, options: { section?: string; scope?: string; repo?: string }) => {
    await knowledgeShowCommand(workspace, options);
  }));

knowledgeCmd
  .command('promote')
  .description('Copy workspace learnings into per-repo base knowledge so they persist across features')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-r, --repo <repo>', 'Target repository (skips the repo prompt)')
  .option('-t, --type <type>', 'Entry type when promoting a message non-interactively')
  .option('-m, --message <msg>', 'Promote this text directly (non-interactive)')
  .option('--title <title>', 'Short title required with --message')
  .option('--move', 'Remove the entry from the workspace file after promoting (default: copy)')
  .option('--all', 'Promote all decisions, gotchas and assumptions without prompting')
  .action(runAction(async (workspace: string | undefined, options: { repo?: string; type?: string; message?: string; title?: string; move?: boolean; all?: boolean }) => {
    await knowledgePromoteCommand(workspace, options);
  }));

// Project command group
const projectCmd = program
  .command('project')
  .alias('proj')
  .description('Manage the project registry — named groups of repos features start from');

projectCmd
  .command('list')
  .alias('ls')
  .description('List all registered projects')
  .action(runAction(projectListCommand));

projectCmd
  .command('add')
  .description('Register a new project')
  .option('-n, --name <name>', 'Project name')
  .option('-r, --repos <paths...>', 'Absolute paths to the repos to include')
  .option('-d, --description <text>', 'Short description')
  .action(runAction(projectAddCommand));

projectCmd
  .command('show')
  .description('Show the details of a project')
  .argument('[id]', 'Project id (prompts when omitted)')
  .action(runAction(projectShowCommand));

projectCmd
  .command('remove')
  .alias('rm')
  .description('Remove a project from the registry (repos on disk are not touched)')
  .argument('[id]', 'Project id (prompts when omitted)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(runAction(projectRemoveCommand));

// Strategy command group
const strategyCmd = program
  .command('strategy')
  .alias('strat')
  .description('Manage teamwork collaboration strategy templates');

strategyCmd
  .command('list')
  .alias('ls')
  .description('List all available strategy templates (built-in and custom)')
  .action(runAction(strategyListCommand));

strategyCmd
  .command('create')
  .description('Create a new custom strategy template')
  .option('-n, --name <name>', 'Strategy name')
  .option('-f, --file <path>', 'Load content from a .md or .txt file')
  .action(runAction(strategyCreateCommand));

strategyCmd
  .command('edit')
  .description('Edit an existing custom strategy template')
  .option('--id <id>', 'Template ID to edit (skips the selection prompt)')
  .action(runAction(strategyEditCommand));

strategyCmd
  .command('delete')
  .alias('rm')
  .description('Delete a custom strategy template')
  .option('--id <id>', 'Template ID to delete (skips the selection prompt)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(runAction(strategyDeleteCommand));

strategyCmd
  .command('show')
  .description('Display the full content of a strategy template')
  .option('--id <id>', 'Template ID to show (skips the selection prompt)')
  .action(runAction(strategyShowCommand));

const desktopCmd = program
  .command('desktop')
  .description(`Launch the ${BRAND_NAME} desktop application`)
  .action(runAction(desktopCommand));

desktopCmd
  .command('install')
  .description('Download, verify, and install the latest Windows/Linux desktop release')
  .action(runAction(desktopInstallCommand));

// Config command group
const configCmd = program.command('config').description(`View and update ${BRAND_NAME} configuration`);

configCmd
  .command('show')
  .description('Display the current configuration')
  .action(runAction(configShowCommand));

configCmd
  .command('get')
  .description('Get a specific configuration key')
  .argument('<key>', 'Configuration key to read')
  .action(runAction(configGetCommand));

configCmd
  .command('set')
  .description('Set a configuration key to a value')
  .argument('<key>', 'Configuration key to set')
  .argument('<value>', 'Value to assign')
  .action(runAction(configSetCommand));

// Default action when 'ctxspace config' is run without a subcommand
configCmd.action(runAction(configShowCommand));

// Adapter command group
const adapterCmd = program.command('adapter').description('Manage storage adapters — list, switch, configure, or create new ones');

adapterCmd
  .command('list')
  .description('List all available storage adapters')
  .action(runAction(adapterListCommand));

adapterCmd
  .command('use')
  .description('Switch to a different storage adapter (prompts for config if needed)')
  .argument('<name>', 'Adapter name to activate')
  .action(runAction(adapterUseCommand));

adapterCmd
  .command('info')
  .description('Show detailed information about an adapter')
  .argument('<name>', 'Adapter name to inspect')
  .action(runAction(adapterInfoCommand));

adapterCmd
  .command('init')
  .description('Scaffold a new adapter plugin project')
  .argument('<name>', 'Name for the new adapter')
  .action(runAction(adapterInitCommand));

// Default action when 'ctxspace adapter' is run without a subcommand
adapterCmd.action(runAction(adapterListCommand));

// Schedule command group
const scheduleCmd = program
  .command('schedule')
  .description(`Manage recurring workspace jobs (sync/refresh) — jobs run while a ${BRAND_NAME} server is active`)
  .option('--json', 'Output in JSON format');

scheduleCmd
  .command('add')
  .description('Schedule a recurring job for a workspace')
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-t, --task <task>', 'Job to run: "sync" or "refresh"', 'sync')
  .requiredOption('-e, --every <interval>', 'How often to run, e.g. 30m, 2h, 1d')
  .action(runAction(async (workspace: string | undefined, options: { task?: string; every?: string }) => {
    await scheduleAddCommand(workspace, options);
  }));

scheduleCmd
  .command('list')
  .alias('ls')
  .description('List all scheduled jobs')
  .option('--json', 'Output in JSON format')
  .action(runAction(scheduleListCommand));

scheduleCmd
  .command('remove')
  .alias('rm')
  .description('Remove a scheduled job')
  .argument('<id>', `Job id (see "${CLI_NAME} schedule list")`)
  .action(runAction(scheduleRemoveCommand));

scheduleCmd
  .command('enable')
  .description('Enable a scheduled job')
  .argument('<id>', `Job id (see "${CLI_NAME} schedule list")`)
  .action(runAction(async (id: string) => {
    await scheduleToggleCommand(id, true);
  }));

scheduleCmd
  .command('disable')
  .description('Disable a scheduled job without removing it')
  .argument('<id>', `Job id (see "${CLI_NAME} schedule list")`)
  .action(runAction(async (id: string) => {
    await scheduleToggleCommand(id, false);
  }));

scheduleCmd
  .command('run')
  .description('Run a scheduled job immediately')
  .argument('<id>', `Job id (see "${CLI_NAME} schedule list")`)
  .action(runAction(scheduleRunCommand));

// Default action when 'ctxspace schedule' is run without a subcommand
scheduleCmd.action(runAction(scheduleListCommand));

const mcp = program.command('mcp').description(`Manage the ${BRAND_NAME} MCP Server for AI assistants`);

mcp
  .command('run')
  .description(`Start the ${BRAND_NAME} MCP Server (typically called automatically by AI assistants)`)
  .argument('[workspace]', 'Path to workspace (auto-detects from CWD)')
  .option('-r, --role <role>', 'Agent execution role for scoped tool surfaces (e.g. readonly, review, ci, developer, full)')
  .option('--allow <tools...>', 'Explicit list of allowed tool names')
  .option('--deny <tools...>', 'Explicit list of denied tool names')
  .action(runAction((workspace, options) => mcpRunCommand(workspace, options)));

mcp
  .command('setup')
  .description(`Automatically configure your AI agents (Claude Code, Codex, Antigravity, Pi) and editors (Claude Desktop, Cursor, VS Code) to use the ${BRAND_NAME} MCP Server`)
  .option('--dry-run', 'Show what would be registered with each AI agent without changing anything')
  .option('--no-agents', 'Configure editors and desktop apps only; leave AI agents (Claude Code, Codex, Antigravity, Pi) alone')
  .action(runAction(mcpSetupCommand));

program.hook('postAction', async (thisCommand, actionCommand) => {
  // Skip update check for non-TTY streams and MCP runs to prevent contaminating stdout stream, and inside
  // AI tools, which may run commands in a terminal but have no use for the banner.
  if (!process.stdout.isTTY || runsInsideAiTool() || actionCommand.name() === 'data' || actionCommand.parent?.name() === 'diagnostics'
      || (actionCommand.name() === 'run' && actionCommand.parent?.name() === 'mcp')) {
    return;
  }

  try {
    const status = await checkForUpdates();
    if (status) {
      printUpdateBanner(status);
    }
  } catch {
    // Silently ignore to prevent crashing CLI
  }
});

async function bootstrap() {
  try {
    // Quiet: plugins (which may register storage adapters) are not loaded yet,
    // so a storage-adapter warning here would be a false alarm.
    const config = await loadConfig({ quiet: true });
    if (config.plugins && config.plugins.length > 0) {
      await loadPlugins(program, config.plugins);
    }
  } catch (error) {
    console.warn(chalk.yellow('⚠ Plugin loading failed — continuing without plugins.'));
    debugLog('plugins', 'bootstrap', error);
  }
  await program.parseAsync(process.argv);
}

bootstrap();
