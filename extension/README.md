# ContextSpace VS Code Extension

The ContextSpace VS Code Extension integrates multi-repo workspace orchestration, service management, and deterministic AI context alignment directly into Visual Studio Code.

## 📦 Distribution & Installation

The extension is packaged as a `.vsix` bundle and distributed through [ContextSpace GitHub Releases](https://github.com/antan87/Context-Space/releases) (with optional publishing to the VS Code Marketplace).

### Installing from GitHub Releases (Recommended)

1. Download `ContextSpace.vsix` from the latest [ContextSpace GitHub Release](https://github.com/antan87/Context-Space/releases).
2. Install via the command line:
   ```bash
   code --install-extension ContextSpace.vsix
   ```
   Or inside VS Code:
   - Open the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
   - Click the **Views and More Actions** (`...`) menu at the top right of the Extensions view.
   - Select **Install from VSIX...** and choose the downloaded file.

> [!NOTE]
> The extension is distributed directly via GitHub Releases (`.vsix`) and does not use npm for user installation.

## ✨ Features

- **Activity Bar & Sidebar:** Quick access to the ContextSpace Dashboard within VS Code.
- **MCP Server Provider:** Exposes the `contextspace-mcp` definition provider to AI assistants including Claude, GitHub Copilot, and Codex.
- **Workspace Commands:** Palette commands to open dashboard, sync context, create workspaces, run doctor diagnostics, and view status.

## 🛠️ Development from Source

To compile and develop the extension locally:

```bash
# In the extension directory
cd extension
npm install

# Compile TypeScript
npm run compile

# Run in watch mode during development
npm run watch
```

### Testing & Linting

```bash
# Run linter
npm run lint

# Run extension tests
npm test
```

### Packaging VSIX

```bash
# Package into a .vsix artifact using @vscode/vsce
npx @vscode/vsce package
```
