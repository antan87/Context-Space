import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  providers: new Map<string, any>(),
  serverRunning: true,
  spawnHandlers: new Map<string, any>(),
  showErrorMessage: vi.fn(),
  terminals: [] as any[],
  mcp: new Map<string, any>(),
  workspace: { workspaceFolders: [] as any[], onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
}));
vi.mock('vscode', () => ({
  workspace: mocks.workspace,
  commands: { executeCommand: vi.fn(), registerCommand: () => ({ dispose() {} }) },
  StatusBarAlignment: { Left: 1 },
  window: {
    showErrorMessage: mocks.showErrorMessage,
    createTerminal: (options: any) => { mocks.terminals.push(options); return { show() {} }; },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerWebviewViewProvider: (id: string, provider: any) => { mocks.providers.set(id, provider); return { dispose() {} }; },
  },
  lm: { registerMcpServerDefinitionProvider: (id: string, provider: any) => { mocks.mcp.set(id, provider); return { dispose() {} }; } },
  McpStdioServerDefinition: class {
    constructor(public label: string, public command: string, public args: string[] = []) {}
  },
  Uri: { joinPath: (_root: any, ...parts: string[]) => parts.join('/') },
}));
vi.mock('http', () => ({ get: (_url: string, callback: any) => {
  callback({ statusCode: mocks.serverRunning ? 200 : 503 });
  return { on() {}, setTimeout() {} };
} }));
vi.mock('child_process', () => ({
  spawn: () => ({ on: (event: string, handler: any) => { mocks.spawnHandlers.set(event, handler); } }),
}));
import { activate } from './extension.js';

let temp = '';
afterEach(() => {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  mocks.serverRunning = true; mocks.spawnHandlers.clear(); mocks.showErrorMessage.mockClear();
  mocks.terminals = []; mocks.providers.clear(); mocks.mcp.clear(); mocks.workspace.workspaceFolders = [];
});

describe('extension release integration', () => {
  it('registers a launchable MCP definition and CSP-compatible sidebar for a legacy workspace', async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-release-'));
    const repoName = "repo with 'quotes'";
    fs.writeFileSync(path.join(temp, 'nexusflow.json'), JSON.stringify({ id: 'test', repos: [repoName] }));
    fs.writeFileSync(path.join(temp, 'AGENTS.md'), '# Context');
    fs.writeFileSync(path.join(temp, 'nexusflow-knowledge.md'), '# Knowledge');
    mocks.workspace.workspaceFolders = [{ uri: { fsPath: temp } }];
    activate({ extensionPath: temp, extensionUri: temp, subscriptions: [] } as any);
    const definitions = await mocks.mcp.get('contextspace-mcp').provideMcpServerDefinitions();
    expect(definitions[0].label).toBe('ContextSpace MCP Server');
    expect(typeof definitions[0].command).toBe('string');
    expect(definitions[0].command.length).toBeGreaterThan(0);
    expect(definitions[0].args).toContain('mcp');
    expect(definitions[0].args).toContain(temp);
    let receive: any;
    let details: any;
    const webview = {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: any) => uri,
      html: '',
      onDidReceiveMessage: (listener: any) => { receive = listener; },
      postMessage: (message: any) => { details = message.details; },
    };
    mocks.providers.get('contextspace.dashboardView').resolveWebviewView({ webview }, {}, {});
    expect(webview.html).not.toMatch(/\sonclick=/);
    expect(webview.html).toContain('media/codicons/codicon.css');
    receive({ type: 'getWorkspaceStatus' });
    expect(details.hasWorkspace).toBe(true);
    expect(details.repos[0]).toEqual({ name: repoName, path: path.join(temp, repoName) });
    receive({ type: 'runCommand', command: 'tui' });
    expect(mocks.terminals).toHaveLength(1);
    expect(mocks.terminals[0].shellArgs.at(-1)).toBe('tui');
    expect(mocks.terminals[0].cwd).toBe(temp);
    expect(typeof mocks.terminals[0].shellPath).toBe('string');
    receive({ type: 'runCommand', command: 'tui & unexpected' });
    receive({ type: 'executeTerminalCommand', command: 'unexpected' });
    expect(mocks.terminals).toHaveLength(1);
    expect(details.contextFiles.map((file: any) => file.name)).toEqual(['AGENTS.md', 'nexusflow-knowledge.md']);
  });
});


it.each(['spawn error', 'early exit'])('reports a recoverable dashboard %s without crashing the extension host', async (failure) => {
  mocks.serverRunning = false;
  activate({ extensionPath: '/missing-extension', extensionUri: '/missing-extension', subscriptions: [] } as any);
  await vi.waitFor(() => expect(mocks.spawnHandlers.has('error')).toBe(true));
  if (failure === 'spawn error') mocks.spawnHandlers.get('error')(new Error('spawn ctxspace ENOENT'));
  mocks.spawnHandlers.get('close')(1);
  expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
  expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('github.com/antan87/Context-Space/releases'));
});
