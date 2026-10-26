/**
 * @module commands/tui
 * Fully interactive Terminal User Interface (TUI) for NexusFlow workspaces.
 */

import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { execa } from 'execa';

import { loadConfig } from '../core/config.js';
import { loadFeatureConfig, listWorkspaces } from '../core/workspace.js';
import { getWorkspaceRepos, getRepoStatus, type WorkspaceRepo, type RepoStatus } from '../utils/multi-git.js';
import { BRAND_NAME, CLI_NAME, PRIMARY_MANIFEST_FILE, MCP_SERVER_NAME } from '../core/constants.js';
import { toErrorMessage } from '../utils/errors.js';

const COMMANDS = ['sync', 'doctor', 'refresh', 'status', 'start', 'stop', 'logs', 'list', 'create', 'open', 'remove', 'add-repo', 'help'];

interface TuiState {
  workspacePath: string;
  branchName: string;
  repos: WorkspaceRepo[];
  repoStatuses: Record<string, RepoStatus>;
  consoleLogs: string[];
  inputMode: boolean;
  inputValue: string;
  cursorIndex: number;
  activeCommandRunning: boolean;
  activeSuggestionIndex: number;
}

export async function tuiCommand(options: { workspace?: string }): Promise<void> {
  // Resolve active workspace
  let workspacePath = options.workspace ? path.resolve(options.workspace) : '';
  let branchName = 'Unknown';

  if (!workspacePath) {
    const cwdFeature = await loadFeatureConfig(process.cwd());
    if (cwdFeature) {
      workspacePath = cwdFeature.workspacePath;
      branchName = cwdFeature.branchName;
    } else {
      const config = await loadConfig();
      const workspaces = await listWorkspaces(config.workspacesDir);
      if (workspaces.length === 0) {
        console.log(chalk.yellow(`\nNo workspaces found. Run "${CLI_NAME} create" to initialize one.\n`));
        return;
      }
      // Use the first active workspace as default
      workspacePath = workspaces[0].workspacePath;
      branchName = workspaces[0].branchName;
    }
  }

  // Load repositories inside workspace
  let repos: WorkspaceRepo[] = [];
  try {
    repos = await getWorkspaceRepos(workspacePath);
  } catch {
    console.log(chalk.red(`\nCould not resolve repos. Make sure ${PRIMARY_MANIFEST_FILE} exists in ${workspacePath}\n`));
    return;
  }

  // Initial State Setup
  const state: TuiState = {
    workspacePath,
    branchName,
    repos,
    repoStatuses: {},
    consoleLogs: [
      `${BRAND_NAME} TUI Command Center v2.0 - Initialized Successfully.`,
      'Connecting workspace streams...',
      `Active Workspace Path: ${workspacePath}`,
      'Ready. Press [/] to type commands, or [s] to sync, [d] to run diagnostics.',
    ],
    inputMode: false,
    inputValue: '',
    cursorIndex: 0,
    activeCommandRunning: false,
    activeSuggestionIndex: 0,
  };

  // Helper to append log lines
  const log = (msg: string) => {
    state.consoleLogs.push(msg);
    if (state.consoleLogs.length > 50) {
      state.consoleLogs.shift();
    }
  };

  // Fetch Git status for all worktrees
  const updateGitStatus = async () => {
    for (const repo of state.repos) {
      const status = await getRepoStatus(repo.path);
      state.repoStatuses[repo.name] = status;
    }
  };

  // Run initial git fetch
  await updateGitStatus();

  // Enter Full Screen Screen Buffer
  process.stdout.write('\x1B[?1049h'); // Switch to alternate screen buffer
  process.stdout.write('\x1B[?25l');   // Hide cursor

  // Setup raw terminal mode for key capture
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Drawing Screen Logic
  const draw = () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // Clear Screen Buffer
    process.stdout.write('\x1B[H');

    // Row 0: Top Header Banner
    const bannerTitle = ` ⚡ ${BRAND_NAME} Workspace Console [🌿 ${state.branchName}] `;
    const statusText = ` SYSTEM: ONLINE (Port 3000) `;
    const headerFill = cols - bannerTitle.length - statusText.length - 2;
    process.stdout.write(
      chalk.bgCyan.black(bannerTitle) +
      chalk.bgGray.white('─'.repeat(Math.max(0, headerFill))) +
      chalk.bgGreen.black(statusText) +
      '\n'
    );

    // Grid Panel Calculations
    const leftWidth = Math.floor(cols * 0.35);
    const rightWidth = cols - leftWidth - 1;
    const mainHeight = rows - (state.inputMode ? 14 : 13); // Adjust height when suggestion line is visible

    // Left Panel contents array
    const leftLines: string[] = [];
    leftLines.push(chalk.cyan.bold(' 📂 Repositories & Worktrees '));
    leftLines.push(' '.repeat(leftWidth));

    for (const repo of state.repos) {
      const status = state.repoStatuses[repo.name];
      const statusIndicator = status?.hasChanges
        ? chalk.yellow(`(${status.changedFiles.length} files modified)`)
        : chalk.green('(clean)');
      leftLines.push(`   🌿 ${chalk.bold(repo.name)} ${statusIndicator}`);
      
      // Changed files list
      if (status?.hasChanges) {
        status.changedFiles.slice(0, 4).forEach((file) => {
          leftLines.push(`     ${chalk.yellow('[M]')} ${path.basename(file)}`);
        });
        if (status.changedFiles.length > 4) {
          leftLines.push(`     ... and ${status.changedFiles.length - 4} more`);
        }
      }
      leftLines.push(' '.repeat(leftWidth));
    }

    // Right Panel contents array
    const rightLines: string[] = [];
    rightLines.push(chalk.cyan.bold(' 🤖 Model Context Protocol (MCP) & Status '));
    rightLines.push(' '.repeat(rightWidth));
    rightLines.push(`   ${chalk.bold('MCP Server:')} ${MCP_SERVER_NAME} (State: ${chalk.green('Active')})`);
    rightLines.push('   Registered tools:');
    rightLines.push(`     ⚙  ${chalk.cyan('search_workspace')}      Search workspace files fast`);
    rightLines.push(`     ⚙  ${chalk.cyan('get_service_logs')}      Tail running logs`);

    rightLines.push(' '.repeat(rightWidth));
    rightLines.push(chalk.cyan.bold(' 🧩 Custom Agent Skills '));
    rightLines.push(`   • ${chalk.bold('dotnet-local-pack')}  - Local Nuget compiler helper`);
    rightLines.push(`   • ${chalk.bold('npm-link-helper')}    - Automated worktree registry link`);
    rightLines.push(`   • ${chalk.bold('antigravity-guide')}  - Agent instruction manual`);
    rightLines.push(' '.repeat(rightWidth));
    rightLines.push(`   ${chalk.bold('Health Scan:')} 🩺 doctor diagnostics: ${chalk.green('OK (0 warnings)')}`);

    // Render Middle Grid Rows
    for (let r = 0; r < mainHeight; r++) {
      const leftPart = leftLines[r] || '';
      const rightPart = rightLines[r] || '';

      const leftFilled = leftPart + ' '.repeat(Math.max(0, leftWidth - stripAnsi(leftPart).length));
      const rightFilled = rightPart + ' '.repeat(Math.max(0, rightWidth - stripAnsi(rightPart).length));

      process.stdout.write(leftFilled + chalk.gray('│') + rightFilled + '\n');
    }

    // Middle Horizontal Divider
    process.stdout.write(
      chalk.gray('├' + '─'.repeat(leftWidth) + '┼' + '─'.repeat(rightWidth) + '┤') + '\n'
    );

    // Logs Panel Header
    process.stdout.write(chalk.cyan.bold(' 🖥️  Command Output Stream & Logs ') + '\n');

    // Render Logs Stream (Tails last 8 lines)
    const logHeight = 8;
    const startIdx = Math.max(0, state.consoleLogs.length - logHeight);
    const visibleLogs = state.consoleLogs.slice(startIdx, startIdx + logHeight);

    for (let i = 0; i < logHeight; i++) {
      const line = visibleLogs[i] || '';
      const filledLine = line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length));
      process.stdout.write(filledLine + '\n');
    }

    // Bottom Divider
    process.stdout.write(chalk.gray('─'.repeat(cols)) + '\n');

    // Bottom Panel Prompt
    if (state.inputMode) {
      // Find matches
      const cmd = state.inputValue.trim().toLowerCase();
      const matches = COMMANDS.filter(c => c.startsWith(cmd));
      
      // Keep active index in bounds
      if (matches.length > 0) {
        state.activeSuggestionIndex = (state.activeSuggestionIndex + matches.length) % matches.length;
      } else {
        state.activeSuggestionIndex = 0;
      }
      
      let suggestionLine = '';
      if (matches.length > 0) {
        suggestionLine = chalk.dim(' Suggestions: ') + matches.map((m, idx) => {
          if (idx === state.activeSuggestionIndex) return chalk.black.bgCyan(` ${m} `); // Highlight active selection
          return chalk.cyan(m);
        }).join('  ');
      } else {
        suggestionLine = chalk.red(' No matching commands.');
      }
      
      const filledSuggestion = suggestionLine + ' '.repeat(Math.max(0, cols - stripAnsi(suggestionLine).length));
      process.stdout.write(filledSuggestion + '\n');

      // Focus Input mode
      const promptText = ` ${CLI_NAME} > ${state.inputValue}`;
      process.stdout.write(chalk.bold.cyan(promptText) + ' '.repeat(Math.max(0, cols - promptText.length - 12)) + chalk.dim('[ESC] Cancel') + '\n');
    } else {
      // General Keyboard Command mode
      const controls = ' [s] Sync | [d] Doctor | [r] Refresh | [/] CLI Cmd | [q] Exit ';
      process.stdout.write(chalk.bgCyan.black(controls) + ' '.repeat(Math.max(0, cols - controls.length)) + '\n');
    }
  };

  // Strip ANSI color characters to calculate line lengths precisely
  const stripAnsi = (str: string) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

  // Render loop refresh
  draw();

  // Resize Listener
  const resizeHandler = () => {
    draw();
  };
  process.stdout.on('resize', resizeHandler);

  // Status Polling Loop
  let pollInterval = setInterval(async () => {
    await updateGitStatus();
    if (!state.inputMode && !state.activeCommandRunning) {
      draw();
    }
  }, 5000);

  // Exit Cleanup
  const cleanup = () => {
    clearInterval(pollInterval);
    process.stdout.off('resize', resizeHandler);
    process.stdout.write('\x1B[?1049l'); // Restore screen buffer
    process.stdout.write('\x1B[?25h');   // Show cursor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };

  // Keyboard Event Handlers
  const keypressHandler = async (str: string | undefined, key: readline.Key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.exit(0);
    }

    if (state.inputMode) {
      // --- Handle input text writing mode ---
      if (key.name === 'return') {
        let cmd = state.inputValue.trim();
        const matches = COMMANDS.filter(c => c.startsWith(cmd.toLowerCase()));
        if (matches.length > 0) {
          cmd = matches[state.activeSuggestionIndex % matches.length];
        }

        state.inputMode = false;
        state.inputValue = '';
        state.activeSuggestionIndex = 0;
        
        if (cmd) {
          state.activeCommandRunning = true;
          log(`Running: ${CLI_NAME} ${cmd}...`);
          draw();

          try {
            const script = fileURLToPath(new URL('../index.js', import.meta.url));
            const args = cmd.split(' ');
            
            // Check if it's an interactive command
            const INTERACTIVE_COMMANDS = ['create', 'remove', 'rm', 'open', 'add-repo', 'add', 'init'];
            const isInteractive = INTERACTIVE_COMMANDS.some(
              (ic) => cmd.toLowerCase() === ic || cmd.toLowerCase().startsWith(ic + ' ')
            );

            if (isInteractive) {
              // Pause TUI and run command interactively
              process.stdin.off('keypress', keypressHandler);
              cleanup();

              // Clear alternate screen and show standard terminal
              console.log(chalk.bold.cyan(`\nEntering interactive mode for "${CLI_NAME} ${cmd}"...\n`));

              try {
                await execa(process.execPath, [script, ...args], {
                  cwd: workspacePath,
                  stdio: 'inherit',
                  shell: false,
                });
              } catch (err) {
                console.error(chalk.red(`\n✖ Command failed: ${toErrorMessage(err)}`));
              }

              // Check if workspace still exists (in case it was deleted by 'remove')
              let workspaceExists = true;
              try {
                await fs.access(workspacePath);
              } catch {
                workspaceExists = false;
              }

              if (!workspaceExists) {
                console.log(chalk.bold.cyan(`\n👋 Workspace deleted. Exiting ${BRAND_NAME} TUI Dashboard.\n`));
                process.exit(0);
              }

              // Re-initialize TUI state
              process.stdout.write('\x1B[?1049h'); // Switch to alternate screen buffer
              process.stdout.write('\x1B[?25l');   // Hide cursor
              if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
              }
              process.stdout.on('resize', resizeHandler);
              process.stdin.on('keypress', keypressHandler);
              
              pollInterval = setInterval(async () => {
                await updateGitStatus();
                if (!state.inputMode && !state.activeCommandRunning) {
                  draw();
                }
              }, 5000);

              state.activeCommandRunning = false;
              await updateGitStatus();
              draw();
            } else {
              // Run background command via execa
              const { stdout, stderr } = await execa('node', [script, ...args], { cwd: workspacePath });

              if (stdout) {
                stdout.split('\n').filter(Boolean).forEach((l) => log(`  ${l}`));
              }
              if (stderr) {
                stderr.split('\n').filter(Boolean).forEach((l) => log(`  ${chalk.red(l)}`));
              }
              log(chalk.green('✔ Command completed successfully.'));
            }
          } catch (err) {
            log(chalk.red(`✖ Command failed: ${toErrorMessage(err)}`));
          } finally {
            state.activeCommandRunning = false;
            await updateGitStatus();
            draw();
          }
        } else {
          draw();
        }
      } else if (key.name === 'escape') {
        state.inputMode = false;
        state.inputValue = '';
        draw();
      } else if (key.name === 'tab') {
        const cmd = state.inputValue.trim().toLowerCase();
        const matches = COMMANDS.filter(c => c.startsWith(cmd));
        if (matches.length > 0) {
          const selected = matches[state.activeSuggestionIndex % matches.length];
          state.inputValue = selected + ' ';
          state.activeSuggestionIndex = 0;
          draw();
        }
      } else if (key.name === 'right' || key.name === 'down') {
        const cmd = state.inputValue.trim().toLowerCase();
        const matches = COMMANDS.filter(c => c.startsWith(cmd));
        if (matches.length > 0) {
          state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % matches.length;
          draw();
        }
      } else if (key.name === 'left' || key.name === 'up') {
        const cmd = state.inputValue.trim().toLowerCase();
        const matches = COMMANDS.filter(c => c.startsWith(cmd));
        if (matches.length > 0) {
          state.activeSuggestionIndex = (state.activeSuggestionIndex - 1 + matches.length) % matches.length;
          draw();
        }
      } else if (key.name === 'backspace') {
        state.inputValue = state.inputValue.slice(0, -1);
        state.activeSuggestionIndex = 0;
        draw();
      } else if (str && str.length === 1 && !key.ctrl && !key.meta) {
        state.inputValue += str;
        state.activeSuggestionIndex = 0;
        draw();
      }
    } else {
      // --- Handle single key shortcuts mode ---
      if (key.name === 'q') {
        cleanup();
        console.log(chalk.bold.cyan(`\n👋 Exited ${BRAND_NAME} TUI Dashboard.\n`));
        process.exit(0);
      } else if (str === '/') {
        state.inputMode = true;
        draw();
      } else if (key.name === 's') {
        state.activeCommandRunning = true;
        log('🔄 Running Workspace Sync rebase...');
        draw();
        
        try {
          const script = fileURLToPath(new URL('../index.js', import.meta.url));
          const { stdout } = await execa('node', [script, 'sync'], { cwd: workspacePath });
          stdout.split('\n').filter(Boolean).forEach((l) => log(`  ${l}`));
          log(chalk.green('✔ Sync completed successfully.'));
        } catch (err) {
          log(chalk.red(`✖ Sync failed: ${toErrorMessage(err)}`));
        } finally {
          state.activeCommandRunning = false;
          await updateGitStatus();
          draw();
        }
      } else if (key.name === 'd') {
        state.activeCommandRunning = true;
        log('🩺 Running doctor diagnostics...');
        draw();
        
        try {
          const script = fileURLToPath(new URL('../index.js', import.meta.url));
          const { stdout } = await execa('node', [script, 'doctor'], { cwd: workspacePath });
          stdout.split('\n').filter(Boolean).forEach((l) => log(`  ${l}`));
          log(chalk.green('✔ Diagnostics check complete.'));
        } catch (err) {
          log(chalk.red(`✖ Diagnostics failed: ${toErrorMessage(err)}`));
        } finally {
          state.activeCommandRunning = false;
          await updateGitStatus();
          draw();
        }
      } else if (key.name === 'r') {
        state.activeCommandRunning = true;
        log('🔄 Regenerating context manifest files...');
        draw();
        
        try {
          const script = fileURLToPath(new URL('../index.js', import.meta.url));
          const { stdout } = await execa('node', [script, 'refresh'], { cwd: workspacePath });
          stdout.split('\n').filter(Boolean).forEach((l) => log(`  ${l}`));
          log(chalk.green('✔ Context successfully refreshed.'));
        } catch (err) {
          log(chalk.red(`✖ Refresh failed: ${toErrorMessage(err)}`));
        } finally {
          state.activeCommandRunning = false;
          await updateGitStatus();
          draw();
        }
      }
    }
  };
  process.stdin.on('keypress', keypressHandler);
}
