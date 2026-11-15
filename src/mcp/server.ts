import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { format } from 'node:util';

import { loadConfig } from '../core/config.js';
import type { NexusFlowConfig } from '../types.js';
import { enabledTools, isAgentRole, type AgentRole, type ToolContext } from './tools.js';
import { MCP_SERVER_NAME } from '../core/constants.js';
import { toErrorMessage, getErrorCode } from '../utils/errors.js';

export interface McpServerOptions {
  workspacePath?: string;
  role?: string;
  allowList?: string[];
  denyList?: string[];
}

export function resolveMcpExecutionRole(role: string | undefined): AgentRole {
  if (role === undefined) return 'readonly';
  if (!isAgentRole(role)) throw new Error(`Invalid MCP execution role: ${role}`);
  return role;
}

/** Roles driven by the user's own assistant session, which may address any workspace by ID. */
const CROSS_WORKSPACE_ROLES: ReadonlySet<AgentRole> = new Set(['interactive', 'full']);

/**
 * Resolves the workspace path for a tool call.
 *
 * Without a bound workspace, `args.workspaceId` is resolved under
 * `config.workspacesDir`, falling back to the current working directory. A
 * `workspaceId` that resolves outside `workspacesDir` (via `..`, an absolute
 * path or a link) is rejected.
 *
 * A server bound to a workspace (`mcp run <path>`) uses it by default. A
 * `workspaceId` naming that same workspace is accepted. One naming a different
 * workspace is honored only for user-driven roles (`interactive`, `full`); for
 * every other role it is an error. It is never silently ignored, because tools
 * would otherwise write to the bound workspace while the caller believes it
 * targeted another.
 */
export async function resolveMcpWorkspacePath(
  explicit: string | undefined,
  config: NexusFlowConfig,
  args: Record<string, unknown> | undefined,
  role?: AgentRole,
): Promise<string> {
  const workspaceId = args && typeof args.workspaceId === 'string' && args.workspaceId.length > 0
    ? args.workspaceId
    : undefined;

  if (!workspaceId) return explicit ?? process.cwd();
  if (explicit && workspaceId === path.basename(path.resolve(explicit))) return explicit;

  const target = await resolveWorkspaceId(workspaceId, config);
  if (!explicit) return target;
  if (target === await fs.realpath(explicit).catch(() => path.resolve(explicit))) return explicit;
  if (role && CROSS_WORKSPACE_ROLES.has(role)) return target;
  throw new Error(
    `This MCP server is bound to workspace "${path.basename(path.resolve(explicit))}" with role "${role ?? 'readonly'}", `
    + `which cannot act on workspace "${workspaceId}". Omit workspaceId, or use that workspace's own session.`,
  );
}

async function resolveWorkspaceId(workspaceId: string, config: NexusFlowConfig): Promise<string> {
  const base = path.resolve(config.workspacesDir);
  const resolved = path.resolve(base, workspaceId);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid workspaceId "${workspaceId}": resolves outside the workspaces directory.`);
  }
  let canonicalBase: string;
  let canonicalWorkspace: string;
  try {
    [canonicalBase, canonicalWorkspace] = await Promise.all([fs.realpath(base), fs.realpath(resolved)]);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') throw new Error(`Workspace "${workspaceId}" was not found in the workspaces directory.`);
    throw error;
  }
  const canonicalRel = path.relative(canonicalBase, canonicalWorkspace);
  if (canonicalRel === '' || canonicalRel.startsWith('..') || path.isAbsolute(canonicalRel)) {
    throw new Error(`Invalid workspaceId "${workspaceId}": resolves outside the workspaces directory through a linked path.`);
  }
  return canonicalWorkspace;
}

/**
 * Stdout carries the MCP protocol. Core code logs progress with console.log
 * (refresh, service stop, generators); route it to stderr so a tool can never
 * write into the protocol stream. The transport writes to stdout directly.
 */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => { process.stderr.write(`${format(...args)}\n`); };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

export async function startMcpServer(optionsOrWorkspacePath?: string | McpServerOptions) {
  routeConsoleToStderr();
  const options: McpServerOptions = typeof optionsOrWorkspacePath === 'string'
    ? { workspacePath: optionsOrWorkspacePath }
    : optionsOrWorkspacePath ?? {};

  const { workspacePath, allowList, denyList } = options;
  const role = resolveMcpExecutionRole(options.role);

  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const config = await loadConfig();
    return {
      tools: enabledTools(config, role, allowList, denyList).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const config = await loadConfig();

    const available = enabledTools(config, role, allowList, denyList);
    const tool = available.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool not found or denied by execution policy: ${name}` }],
        isError: true,
      };
    }

    let resolvedWorkspacePath: string;
    try {
      resolvedWorkspacePath = await resolveMcpWorkspacePath(workspacePath, config, args as Record<string, unknown> | undefined, role);
    } catch (error) {
      return {
        content: [{ type: 'text', text: toErrorMessage(error) }],
        isError: true,
      };
    }

    const ctx: ToolContext = { config, workspacePath: resolvedWorkspacePath, ...(workspacePath ? { boundWorkspacePath: workspacePath } : {}) };
    return tool.handler((args ?? {}) as Record<string, unknown>, ctx) as unknown as ServerResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
