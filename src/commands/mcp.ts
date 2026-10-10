import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { startMcpServer, type McpServerOptions } from '../mcp/server.js';
import { BRAND_NAME, BRAND_CONFIG, CLI_NAME } from '../core/constants.js';
import { registerAgentMcp, unboundMcpServer, type AgentMcpResult } from '../core/agent-mcp.js';

export interface McpRunOptions {
  role?: string;
  allow?: string[];
  deny?: string[];
}

export interface McpSetupOptions {
  /** Report what would be registered with each agent; change nothing. */
  dryRun?: boolean;
  /** `--no-agents` sets this to false: configure editors only. */
  agents?: boolean;
}

export async function mcpRunCommand(workspace?: string, options?: McpRunOptions) {
  // If not provided, it attempts to use process.cwd() or waits for workspaceId in MCP calls.
  // The startMcpServer function handles this.
  await startMcpServer({
    workspacePath: workspace,
    role: options?.role,
    allowList: options?.allow,
    denyList: options?.deny,
  });
}

/**
 * Writes the server into editor and desktop-app MCP config files that already exist.
 * A file that already holds exactly this entry is left as it is.
 */
async function configureEditors(): Promise<{ updated: number; unchanged: number }> {
  const isWin = os.platform() === 'win32';
  const isMac = os.platform() === 'darwin';
  const home = os.homedir();

  const configPaths = [
    // Cursor
    path.join(home, '.cursor', 'mcp.json'),
    // VS Code Insiders (for Antigravity/Copilot)
    isWin
      ? path.join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'mcp.json')
      : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json')
        : path.join(home, '.config', 'Code - Insiders', 'User', 'mcp.json'),
    // VS Code (Stable)
    isWin
      ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
      : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : path.join(home, '.config', 'Code', 'User', 'mcp.json'),
    // Claude Desktop
    isWin
      ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : isMac
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : ''
  ].filter(Boolean);

  // Setup is an explicit grant for the normal workspace-management surface.
  // Ad-hoc `mcp run` remains read-only unless its caller names a role.
  const mcpConfig = unboundMcpServer();

  let updatedCount = 0;
  let unchangedCount = 0;

  for (const configPath of configPaths) {
    if (!configPath) continue;
    try {
      let configData: any = { mcpServers: {} };

      try {
        const raw = await fs.readFile(configPath, 'utf8');
        // Handle empty or invalid files gracefully
        if (raw.trim()) {
            configData = JSON.parse(raw);
        }
        if (!configData.mcpServers) configData.mcpServers = {};
      } catch (e: any) {
        if (e?.code === 'ENOENT') {
          // File doesn't exist, we will create it if the directory exists
          const dir = path.dirname(configPath);
          try {
            await fs.access(dir);
          } catch {
            // Directory doesn't exist, skip this environment
            continue;
          }
        } else {
          throw e;
        }
      }

      if (JSON.stringify(configData.mcpServers[BRAND_CONFIG.mcp.serverName]) === JSON.stringify(mcpConfig)) {
        console.log(chalk.gray(`  ✓ Already configured: ${configPath}`));
        unchangedCount++;
        continue;
      }
      configData.mcpServers[BRAND_CONFIG.mcp.serverName] = mcpConfig;

      await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf8');
      console.log(chalk.green(`  ✓ Configured MCP in: ${configPath}`));
      updatedCount++;
    } catch (e: any) {
      console.log(chalk.gray(`  - Skipped ${configPath} (${e.message})`));
    }
  }

  return { updated: updatedCount, unchanged: unchangedCount };
}

function describeAgentResult({ name, outcome }: AgentMcpResult): string {
  switch (outcome.result) {
    case 'not-installed': return chalk.gray(`  - ${name}: not installed`);
    case 'added': return chalk.green(`  ✓ ${name}: registered (${outcome.how})`);
    case 'would-add': return chalk.cyan(`  + ${name}: would register (${outcome.how})`);
    case 'already': return chalk.gray(`  ✓ ${name}: already available as "${outcome.serverName}"`);
    case 'skipped': return chalk.yellow(`  ! ${name}: ${outcome.reason}`);
    case 'failed': return chalk.red(`  ✗ ${name}: failed: ${outcome.reason}`);
  }
}

/**
 * After registering on Windows, how to confirm the server really connected. Setup checks the agent's
 * config, which proves the entry is there; only the agent itself can prove it starts through `cmd /c`.
 */
export function windowsVerificationHint(agents: AgentMcpResult[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [];
  const added = agents.filter((agent) => agent.outcome.result === 'added');
  if (added.length === 0) return [];
  const listing = added
    .filter((agent) => agent.id === 'claude' || agent.id === 'codex')
    .map((agent) => `\`${agent.id} mcp list\``);
  return [
    'On Windows the server starts through `cmd /c npx`. To confirm it connected:',
    `  1. Restart the agent${listing.length ? `, then run ${listing.join(' or ')} to see it listed` : ''}.`,
    '  2. Ask the agent to call `get_work_context`. A real answer means it works.',
    `  If it does not connect, run \`${CLI_NAME} doctor\` and report it as an issue.`,
  ];
}

export async function mcpSetupCommand(options: McpSetupOptions = {}) {
  console.log(chalk.blue.bold(`\nSetting up ${BRAND_NAME} MCP Server for AI Assistants...`));

  // Editor and desktop-app configs are written directly and cannot be previewed.
  let editorsUpdated = 0;
  let editorsUnchanged = 0;
  if (options.dryRun) {
    console.log(chalk.gray('  Dry run: editor and desktop-app configs (Cursor, VS Code, Claude Desktop) are neither changed nor previewed.'));
  } else {
    ({ updated: editorsUpdated, unchanged: editorsUnchanged } = await configureEditors());
  }

  let agents: AgentMcpResult[] = [];
  if (options.agents === false) {
    console.log(chalk.gray('\nAI agents: left alone (--no-agents).'));
  } else {
    console.log(chalk.bold(`\nAI agents${options.dryRun ? ' (dry run, nothing is changed)' : ''}:`));
    // The same grant the editor configs get, and the same one a hand-made registration would give.
    console.log(chalk.gray('  Registered with the "interactive" role: the agent can create, commit and archive workspaces.'));
    console.log(chalk.gray('  Use --no-agents to configure editors only.'));
    agents = await registerAgentMcp({ dryRun: options.dryRun });
    for (const agent of agents) console.log(describeAgentResult(agent));
  }

  const count = (result: AgentMcpResult['outcome']['result']) => agents.filter((agent) => agent.outcome.result === result).length;
  const added = count('added');
  const failed = count('failed');
  const agentFound = agents.some((agent) => agent.outcome.result !== 'not-installed');
  if (failed > 0) process.exitCode = 1;

  if (options.dryRun) {
    if (count('would-add') > 0) console.log(chalk.white('\nRun again without --dry-run to apply this.'));
    return;
  }

  if (editorsUpdated + added > 0) {
    console.log(chalk.green.bold(`\nConfigured ${editorsUpdated + added} AI environment${editorsUpdated + added === 1 ? '' : 's'}.`));
    console.log(chalk.white('Restart running agent sessions, editors and Claude Desktop for the changes to take effect.'));
    for (const line of windowsVerificationHint(agents)) console.log(chalk.white(line));
  } else if (failed > 0) {
    // The failure lines above say what went wrong.
  } else if (agentFound || editorsUnchanged > 0) {
    console.log(chalk.green(`\nNothing to change. Run \`${CLI_NAME} doctor\` any time to check again.`));
  } else {
    console.log(chalk.yellow('\nCould not find any AI agent or standard configuration file to update.'));
    console.log('You can manually add this configuration to your mcp.json:');
    console.log(JSON.stringify({ mcpServers: { [BRAND_CONFIG.mcp.serverName]: unboundMcpServer() } }, null, 2));
  }
}
