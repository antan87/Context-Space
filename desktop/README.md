# ContextSpace Desktop

ContextSpace Desktop is the primary native desktop application for ContextSpace, built with [Electron](https://www.electronjs.org/) and packaged with [electron-builder](https://www.electron.build/).

It bundles the full ContextSpace backend runtime, local server, and Web Dashboard GUI into a self-contained desktop application with native window management, optional auto-updates, and system tray integration.

## 📦 Distribution & Installation

ContextSpace Desktop is distributed primarily via [GitHub Releases](https://github.com/antan87/Context-Space/releases). Packaged desktop installers and standalone binaries do not require Node.js or npm.

### Download

Download the installer or binary matching your OS from the latest [ContextSpace GitHub Release](https://github.com/antan87/Context-Space/releases):

- **Windows:** Download and run `ContextSpaceSetup.exe` (NSIS installer).
- **Linux:** Download `ContextSpace-<version>.AppImage` (standalone portable executable binary), make it executable (`chmod +x ContextSpace-*.AppImage`), and run it directly (`./ContextSpace-*.AppImage`), or place it under `~/.local/share/contextspace/ContextSpace.AppImage`.
- **Integrity verification:** Each release includes SHA-256 sidecars (`.sha256`) and update manifests (`latest.yml` and `latest-linux.yml`).

> [!NOTE]
> Distributing or installing ContextSpace via `npm install -g @mrpatronz/nexusflow` is deprecated. Users should download and install standalone desktop installers and binaries directly from [GitHub Releases](https://github.com/antan87/Context-Space/releases).

### Launching

- **Windows:** Launch from the Start menu or desktop shortcut.
- **Linux:** Launch from the Application Menu (search for **ContextSpace**), run `gtk-launch contextspace`, or execute the AppImage directly.
- **CLI Shortcut:** Run `ctxspace desktop` to launch the installed desktop app.

## 🛠️ Development from Source

To build and run ContextSpace Desktop from source:

```bash
# From repository root
npm run setup                 # Installs dependencies across packages and sets up Electron
npm run build                 # Builds backend and GUI

# In the desktop directory
cd desktop
npm install
npm run setup                 # Downloads the local Electron runtime
npm run prepare-backend       # Prepares the backend distribution for bundling
npm start                     # Runs the desktop app in development
```

### Packaging Installers

```bash
# Package into an unpacked local directory
npm run pack

# Build production installers (ContextSpaceSetup.exe on Windows, AppImage on Linux)
npm run build
```

Installers and packages are output to `desktop/dist/`.

### Testing

```bash
# Run Playwright E2E tests for the desktop app
npm run test:e2e
```
