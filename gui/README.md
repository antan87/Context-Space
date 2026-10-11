# ContextSpace Web Dashboard GUI

The frontend interface for ContextSpace, built with [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/), and [Vite](https://vite.dev/).

It provides a dark-themed GUI for multi-repo workspace management, interactive AI agent chat, real-time log streaming, teamwork strategy inspection, and service orchestration.

## 📦 Distribution & Installation

The GUI is not distributed as an independent npm package. Instead, it is packaged and distributed directly through [ContextSpace GitHub Releases](https://github.com/antan87/Context-Space/releases):

1. **Packaged Desktop Application (Recommended):** The GUI is bundled inside the native Electron desktop application distributed via [GitHub Releases](https://github.com/antan87/Context-Space/releases) (`ContextSpaceSetup.exe` for Windows, `ContextSpace-<version>.AppImage` for Linux). End users download and launch the installer or AppImage directly without needing Node.js or npm.
2. **Local Backend Server:** The compiled assets (`dist/`) are bundled into the release and served locally by the ContextSpace server on port 3000 when running `ctxspace dashboard` or `ctxspace ui`.

> [!NOTE]
> End-user installation via `npm install -g @mrpatronz/nexusflow` is deprecated. Users should download pre-built desktop installers or release binaries directly from [GitHub Releases](https://github.com/antan87/Context-Space/releases).

## 🛠️ Development

For frontend development on the GUI:

```bash
# Install dependencies
cd gui
npm install

# Start the Vite development server with HMR
npm run dev
```

When running the Vite dev server separately on `http://localhost:5173`, ensure the backend server is running with `NEXUSFLOW_DASHBOARD_ORIGIN=http://localhost:5173`.

### Building

```bash
# Typecheck and build production assets into dist/
npm run build
```

Production assets are output to `gui/dist/` and served by the ContextSpace backend.

### Testing & Linting

```bash
# Lint the codebase
npm run lint

# Run Playwright end-to-end tests
npm run test:e2e
```
