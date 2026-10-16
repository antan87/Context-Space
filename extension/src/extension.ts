import * as vscode from 'vscode';
import * as http from 'http';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { executeCli } from './quoting.js';
import { resolveCli } from './cliResolver.js';

let serverProcess: child_process.ChildProcess | null = null;
let myStatusBarItem: vscode.StatusBarItem | null = null;

// The extension owns its backend, so it pins the port and starts the server
// with --strict-port (below) rather than chasing an auto-incremented one.
const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

function checkServerRunning(): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`${SERVER_URL}/api/config`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => {
            resolve(false);
        });
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function startHonoServer(context: vscode.ExtensionContext) {
    const isRunning = await checkServerRunning();
    if (isRunning) {
        console.log('Hono server is already running.');
        return;
    }

    console.log('Starting Hono server...');
    const { command, prefixArgs } = resolveCli(context);

    serverProcess = child_process.spawn(
        command,
        [...prefixArgs, 'ui', '--server-only', '--strict-port', '--port', String(SERVER_PORT)],
        {
            cwd: path.join(context.extensionPath, '..'),
            env: { ...process.env },
            detached: false,
            shell: false,
        }
    );

    serverProcess.stdout?.on('data', (data) => {
        console.log(`[Hono Server]: ${data}`);
    });

    serverProcess.stderr?.on('data', (data) => {
        console.error(`[Hono Server Error]: ${data}`);
    });

    let failureReported = false;
    const reportFailure = (detail: string) => {
        if (failureReported) return;
        failureReported = true;
        void vscode.window.showErrorMessage(
            `ContextSpace could not start its dashboard: ${detail}. Install or update ContextSpace from https://github.com/antan87/Context-Space/releases (or run ctxspace desktop install), then reload this window.`
        );
    };
    serverProcess.on('error', (error) => {
        serverProcess = null;
        reportFailure(error.message);
    });
    serverProcess.on('close', (code) => {
        console.log(`Hono server exited with code ${code}`);
        serverProcess = null;
        if (code !== null && code !== 0) reportFailure(`CLI exited with code ${code}`);
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('ContextSpace extension is activating...');
    
    // Start Hono server in background if not running
    startHonoServer(context);

    // Scope keybindings to workspaces where contextspace.json or nexusflow.json exists
    vscode.commands.executeCommand('setContext', 'contextspace.workspaceActive', true);
    vscode.commands.executeCommand('setContext', 'nexusflow.workspaceActive', true);

    // Initialize Status Bar Item
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    myStatusBarItem.command = 'contextspace.openTui';
    context.subscriptions.push(myStatusBarItem);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBarItem));
    updateStatusBarItem();

    // Register Webview Provider
    const provider = new ContextSpaceSidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ContextSpaceSidebarProvider.viewType,
            provider
        )
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'nexusflow.dashboardView',
            provider
        )
    );

    // Register MCP Server Definition Provider if supported by the VS Code version
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
        const mcpProvider: vscode.McpServerDefinitionProvider = {
            provideMcpServerDefinitions: async () => {
                const { command, prefixArgs } = resolveCli(context);
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const args = [...prefixArgs, 'mcp', 'run'];
                if (workspaceFolders && workspaceFolders.length > 0) {
                    args.push(workspaceFolders[0].uri.fsPath);
                }

                return [
                    new vscode.McpStdioServerDefinition('ContextSpace MCP Server', command, args)
                ];
            }
        };
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('contextspace-mcp', mcpProvider)
        );
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('nexusflow-mcp', mcpProvider)
        );
        console.log('ContextSpace MCP Server Definition Provider registered successfully.');
    } else {
        console.log('registerMcpServerDefinitionProvider is not supported on this VS Code version.');
    }

    // Register Focus Dashboard Command
    const openDashboardHandler = () => {
        vscode.commands.executeCommand('workbench.view.extension.contextspace-sidebar');
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.openDashboard', openDashboardHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.openDashboard', openDashboardHandler));

    // Register Open Browser Dashboard Command
    const openBrowserHandler = () => {
        vscode.env.openExternal(vscode.Uri.parse(SERVER_URL));
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.openBrowserDashboard', openBrowserHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.openBrowserDashboard', openBrowserHandler));

    // Register Open TUI Command
    const openTuiHandler = () => {
        runContextSpaceCommand(context, 'tui');
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.openTui', openTuiHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.openTui', openTuiHandler));

    // Register Create Workspace Command
    const createWsHandler = () => {
        runContextSpaceCommand(context, 'create');
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.createWorkspace', createWsHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.createWorkspace', createWsHandler));

    // Register Sync Workspace Command
    const syncWsHandler = () => {
        runContextSpaceCommand(context, 'sync');
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.syncWorkspace', syncWsHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.syncWorkspace', syncWsHandler));

    // Register Run Doctor Command
    const doctorHandler = () => {
        runContextSpaceCommand(context, 'doctor');
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.runDoctor', doctorHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.runDoctor', doctorHandler));

    // Register Commit Workspace Command
    const commitHandler = async () => {
        const message = await vscode.window.showInputBox({
            prompt: 'Enter commit message for all changed repositories in the workspace:',
            placeHolder: 'e.g., feat: implement new UI components'
        });
        if (message) {
            await executeShellFreeCommand(context, ['commit', '-m', message]);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('contextspace.commitWorkspace', commitHandler));
    context.subscriptions.push(vscode.commands.registerCommand('nexusflow.commitWorkspace', commitHandler));
}

let outputChannel: vscode.OutputChannel | null = null;
function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("ContextSpace");
    }
    return outputChannel;
}

export async function executeShellFreeCommand(
    context: vscode.ExtensionContext,
    args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const folders = vscode.workspace.workspaceFolders;
    const isCreate = args.length > 0 && args[0] === 'create';
    if (!isCreate && (!folders || folders.length === 0)) {
        vscode.window.showErrorMessage('No active workspace folders found.');
        return { code: 1, stdout: '', stderr: 'No active workspace folders found.' };
    }

    const cwd = (folders && folders.length > 0) ? folders[0].uri.fsPath : undefined;
    const { command: cliCommand, prefixArgs } = resolveCli(context);
    const channel = getOutputChannel();
    channel.appendLine(`> ${cliCommand} ${[...prefixArgs, ...args].join(' ')}`);

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `ContextSpace: Running ${args[0]}...`,
            cancellable: false,
        },
        async () => {
            return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
                const proc = executeCli(cliCommand, [...prefixArgs, ...args], {
                    cwd,
                    env: { ...process.env },
                });

                let stdout = '';
                let stderr = '';

                proc.stdout?.on('data', (data) => {
                    const text = data.toString();
                    stdout += text;
                    channel.append(text);
                });

                proc.stderr?.on('data', (data) => {
                    const text = data.toString();
                    stderr += text;
                    channel.append(text);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        vscode.window.showInformationMessage(`ContextSpace: ${args[0]} completed successfully.`);
                    } else {
                        vscode.window.showErrorMessage(`ContextSpace: ${args[0]} failed (exit code ${code}).`);
                        channel.show(true);
                    }
                    resolve({ code, stdout, stderr });
                });

                proc.on('error', (err) => {
                    channel.appendLine(`[Error]: ${err.message}`);
                    vscode.window.showErrorMessage(`ContextSpace: Failed to execute command: ${err.message}`);
                    channel.show(true);
                    resolve({ code: 1, stdout, stderr: err.message });
                });
            });
        }
    );
}

function runContextSpaceCommand(context: vscode.ExtensionContext, commandOrArgs: string | string[]) {
    const folders = vscode.workspace.workspaceFolders;
    const args = Array.isArray(commandOrArgs)
        ? commandOrArgs
        : commandOrArgs.trim().split(/\s+/).filter(Boolean);

    // Any command with user input (such as commit) routes to shell-free execution for security
    if (args.length > 0 && args[0] === 'commit') {
        executeShellFreeCommand(context, args);
        return;
    }

    const isCreate = args.length > 0 && args[0] === 'create';
    
    if (!isCreate && (!folders || folders.length === 0)) {
        vscode.window.showErrorMessage('No active workspace folders found.');
        return;
    }
    
    const cwd = (folders && folders.length > 0) ? folders[0].uri.fsPath : undefined;
    const { command: cliCommand, prefixArgs } = resolveCli(context);

    // Launch the CLI itself in the terminal PTY. Arguments never become shell source.
    const terminal = vscode.window.createTerminal({
        name: `ContextSpace: ${args[0] || 'CLI'}`,
        cwd,
        shellPath: cliCommand,
        shellArgs: [...prefixArgs, ...args],
    });
    terminal.show(true);
}

export function deactivate() {
    if (serverProcess) {
        console.log('Stopping Hono server...');
        serverProcess.kill();
    }
}

function getWorkspaceDetails(): any {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return { hasWorkspace: false };
    }
    const rootPath = folders[0].uri.fsPath;
    let manifestPath = path.join(rootPath, 'contextspace.json');
    if (!fs.existsSync(manifestPath)) {
        manifestPath = path.join(rootPath, 'nexusflow.json');
    }
    if (!fs.existsSync(manifestPath)) {
        return { hasWorkspace: false };
    }
    try {
        const content = fs.readFileSync(manifestPath, 'utf8');
        const data = JSON.parse(content);
        return {
            hasWorkspace: true,
            rootPath,
            id: data.id || data.branchName,
            branchName: data.branchName,
            description: data.description || 'No description',
            repos: (data.repos || []).map((repo: string) => ({
                name: path.basename(repo),
                path: data.isolatedRepos?.[path.basename(repo)]?.worktreePath
                    || (data.mode === 'in-place' ? data.originalRepos?.find((original: string) => path.basename(original) === path.basename(repo)) : undefined)
                    || path.resolve(rootPath, repo)
            })),
            contextFiles: [
                ['AGENTS.md', 'WORKSPACE.md'],
                ['contextspace-knowledge.md', 'nexusflow-knowledge.md'],
                ['contextspace-plan.md', 'nexusflow-plan.md'],
            ].flatMap((names) => {
                const name = names.find((candidate) => fs.existsSync(path.join(rootPath, candidate)));
                return name ? [{ name, path: path.join(rootPath, name) }] : [];
            }),
        };
    } catch (e) {
        return { hasWorkspace: false };
    }
}

class ContextSpaceSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'contextspace.dashboardView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _context: vscode.ExtensionContext,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._context.extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((data: any) => {
            switch (data.type) {
                case 'openWorkspaceFolder': {
                    const uri = vscode.Uri.file(data.workspacePath);
                    vscode.commands.executeCommand('vscode.openFolder', uri, false);
                    break;
                }
                case 'openFile': {
                    const uri = vscode.Uri.file(data.filePath);
                    vscode.workspace.openTextDocument(uri).then((doc: vscode.TextDocument) => {
                        vscode.window.showTextDocument(doc);
                    });
                    break;
                }
                case 'getWorkspaceStatus': {
                    const details = getWorkspaceDetails();
                    webviewView.webview.postMessage({ type: 'workspaceStatus', details });
                    break;
                }
                case 'runCommand': {
                    if (['tui', 'sync', 'doctor', 'create'].includes(data.command)) {
                        runContextSpaceCommand(this._context, [data.command]);
                    }
                    break;
                }
                case 'triggerCommand': {
                    vscode.commands.executeCommand(data.command);
                    break;
                }

            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'codicons', 'codicon.css')
        );
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${codiconsUri}" rel="stylesheet" />
    <title>ContextSpace Sidebar Console</title>
    <style>
        :root {
            --bg-base: var(--vscode-sideBar-background, #080a13);
            --bg-surface: var(--vscode-editor-background, #0d1127);
            --accent-cyan: #00f0ff;
            --accent-green: #39ff14;
            --text-primary: var(--vscode-sideBar-foreground, #f0f3ff);
            --text-secondary: var(--vscode-descriptionForeground, #8e9bb4);
            --border-color: rgba(0, 240, 255, 0.15);
        }

        body {
            background-color: var(--bg-base);
            color: var(--text-primary);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 12px;
            margin: 0;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
            margin-bottom: 4px;
        }

        .header h3 {
            margin: 0;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--accent-cyan);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            color: var(--accent-green);
            background: rgba(57, 255, 20, 0.1);
            padding: 2px 6px;
            border-radius: 10px;
            border: 1px solid rgba(57, 255, 20, 0.3);
        }

        .status-dot {
            width: 6px;
            height: 6px;
            background-color: var(--accent-green);
            border-radius: 50%;
            box-shadow: 0 0 6px var(--accent-green);
        }

        .card {
            background-color: var(--bg-surface);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .card h4 {
            margin: 0;
            font-size: 11px;
            text-transform: uppercase;
            color: var(--text-secondary);
            letter-spacing: 0.5px;
        }

        .branch-badge {
            font-family: var(--vscode-editor-font-family, monospace);
            color: var(--accent-cyan);
            font-weight: bold;
            font-size: 12px;
            background: rgba(0, 240, 255, 0.1);
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid rgba(0, 240, 255, 0.2);
            word-break: break-all;
        }

        .desc-text {
            font-size: 11px;
            color: var(--text-secondary);
            line-height: 1.4;
        }

        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }

        .btn {
            background-color: var(--vscode-button-secondaryBackground, #2b3040);
            color: var(--vscode-button-secondaryForeground, #ffffff);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, #3c4257);
            border-color: var(--accent-cyan);
            color: var(--accent-cyan);
        }

        .btn-primary {
            background-color: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #ffffff);
            border: none;
        }

        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground, #0062a3);
            color: #ffffff;
        }

        .file-list {
            list-style: none;
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .file-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 11px;
            font-family: var(--vscode-editor-font-family, monospace);
            cursor: pointer;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid transparent;
        }

        .file-row:hover {
            background: rgba(0, 240, 255, 0.08);
            border-color: rgba(0, 240, 255, 0.3);
            color: var(--accent-cyan);
        }

        .file-icon {
            color: var(--accent-cyan);
            font-size: 12px;
        }

        .wizard-view {
            text-align: center;
            padding: 24px 12px;
        }

        .wizard-icon {
            font-size: 32px;
            color: var(--accent-cyan);
            margin-bottom: 12px;
        }

        .wizard-text {
            color: var(--text-secondary);
            font-size: 12px;
            margin-bottom: 20px;
            line-height: 1.5;
        }
    </style>
</head>
<body>

    <div class="header">
        <h3><i aria-hidden="true" class="codicon codicon-extensions"></i> ContextSpace</h3>
        <div class="status-indicator">
            <div class="status-dot"></div>
            <span>ACTIVE</span>
        </div>
    </div>

    <!-- Active Workspace View -->
    <div id="workspace-view" style="display: none;">
        <div class="card">
            <h4>Active Feature</h4>
            <div class="branch-badge" id="branch-badge">🌿 workspace</div>
            <div class="desc-text" id="workspace-desc">Loading workspace description...</div>
        </div>

        <div class="btn-grid">
            <button class="btn" data-run-command="tui"><i aria-hidden="true" class="codicon codicon-terminal"></i> Open TUI</button>
            <button class="btn" data-run-command="sync"><i aria-hidden="true" class="codicon codicon-sync"></i> Rebase Sync</button>
            <button class="btn" data-run-command="doctor"><i aria-hidden="true" class="codicon codicon-pulse"></i> Run Doctor</button>
            <button class="btn" data-trigger-command="contextspace.commitWorkspace"><i aria-hidden="true" class="codicon codicon-git-commit"></i> Commit</button>
        </div>

        <div class="card">
            <h4>Workspace Repositories</h4>
            <ul class="file-list" id="repo-list">
                <!-- Repo items injected here -->
            </ul>
        </div>

        <div class="card">
            <h4>Core Context Files</h4>
            <ul class="file-list" id="context-files">
                <!-- Links injected here -->
            </ul>
        </div>
    </div>

    <!-- Empty Wizard Setup View -->
    <div id="wizard-view" style="display: none;" class="wizard-view">
        <div class="wizard-icon"><i aria-hidden="true" class="codicon codicon-rocket"></i></div>
        <h4 style="margin-bottom: 8px; font-size: 14px; color: var(--text-primary);">No Workspace Detected</h4>
        <p class="wizard-text">ContextSpace coordinates multi-repo workspaces with Git worktrees and auto-generated AI contexts.</p>
        
        <button class="btn btn-primary" data-trigger-command="contextspace.createWorkspace" style="width: 100%; margin-bottom: 10px;">
            Initialize Workspace Setup
        </button>
        <button class="btn" data-trigger-command="contextspace.openTui" style="width: 100%;">
            Open TUI Dashboard
        </button>
    </div>

    <!-- Loading View -->
    <div id="loading-view" class="loading-view">
        <p style="color: var(--text-secondary);">Querying workspace configuration...</p>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Listen for messages from extension backend
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'workspaceStatus') {
                renderWorkspace(message.details);
            }
        });

        // Request workspace status on load
        vscode.postMessage({ type: 'getWorkspaceStatus' });

        document.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.runCommand) {
                vscode.postMessage({ type: 'runCommand', command: button.dataset.runCommand });
            } else if (button.dataset.triggerCommand) {
                vscode.postMessage({ type: 'triggerCommand', command: button.dataset.triggerCommand });
            }
        });

        function renderFiles(list, files, directory) {
            list.replaceChildren();
            for (const file of files) {
                const item = document.createElement('li');
                const button = document.createElement('button');
                button.className = 'file-row';
                button.style.width = '100%';
                button.style.background = 'transparent';
                button.style.color = 'inherit';
                button.style.border = '0';
                const icon = document.createElement('i');
                icon.setAttribute('aria-hidden', 'true');
                icon.className = directory ? 'codicon codicon-folder file-icon' : 'codicon codicon-file-text file-icon';
                const label = document.createElement('span');
                label.textContent = file.name;
                button.append(icon, label);
                button.addEventListener('click', () => vscode.postMessage({
                    type: directory ? 'openWorkspaceFolder' : 'openFile',
                    workspacePath: file.path,
                    filePath: file.path,
                }));
                item.append(button);
                list.append(item);
            }
        }

        function renderWorkspace(details) {
            document.getElementById('loading-view').style.display = 'none';

            if (details.hasWorkspace) {
                document.getElementById('wizard-view').style.display = 'none';
                document.getElementById('workspace-view').style.display = 'block';

                document.getElementById('branch-badge').innerText = '🌿 ' + details.branchName;
                document.getElementById('workspace-desc').innerText = details.description;

                renderFiles(document.getElementById('repo-list'), details.repos, true);
                renderFiles(document.getElementById('context-files'), details.contextFiles, false);

            } else {
                document.getElementById('workspace-view').style.display = 'none';
                document.getElementById('wizard-view').style.display = 'block';
            }
        }
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function updateStatusBarItem() {
    if (!myStatusBarItem) {
        return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        const branchName = path.basename(folders[0].uri.fsPath);
        myStatusBarItem.text = `$(git-branch) ContextSpace: ${branchName}`;
        myStatusBarItem.tooltip = 'Click to open ContextSpace Terminal Console (TUI)';
        myStatusBarItem.show();
    } else {
        myStatusBarItem.hide();
    }
}
