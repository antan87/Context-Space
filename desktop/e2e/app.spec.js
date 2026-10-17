import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// When CONTEXTSPACE_PACKAGED_EXE is set (CI, after electron-builder), drive the
// real packaged binary — exercising the app.isPackaged path in main.js that
// runs the bundled backend via ELECTRON_RUN_AS_NODE. Otherwise run the dev
// build (`electron .`).
const packagedExe = (process.env.CONTEXTSPACE_PACKAGED_EXE || process.env.NEXUSFLOW_PACKAGED_EXE)
  ? path.resolve(desktopDir, process.env.CONTEXTSPACE_PACKAGED_EXE || process.env.NEXUSFLOW_PACKAGED_EXE)
  : null;

// main.js mirrors its startup + backend output here so a boot failure is
// diagnosable even when Playwright doesn't surface the main-process console.
const logPath = path.join(os.tmpdir(), `contextspace-desktop-e2e-${process.pid}.log`);

function dumpBackendLog(label) {
  try {
    console.log(`\n===== ${label}: ${logPath} =====\n${readFileSync(logPath, 'utf8')}\n=====================================\n`);
  } catch {
    console.log(`\n(no backend log at ${logPath})\n`);
  }
}

test.describe('desktop app', () => {
  /** @type {import('playwright').ElectronApplication} */
  let app;
  /** @type {import('playwright').Page} */
  let window;
  /** Console and page errors the window reported. */
  const pageErrors = [];

  test.beforeAll(async () => {
    const launchEnv = {
      ...process.env,
      CONTEXTSPACE_DESKTOP_LOG: logPath,
      NEXUSFLOW_DESKTOP_LOG: logPath,
    };
    app = packagedExe
      ? await electron.launch({ executablePath: packagedExe, env: launchEnv })
      : await electron.launch({ args: ['.'], cwd: desktopDir, env: launchEnv });
    try {
      window = await app.firstWindow();
      window.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });
      window.on('pageerror', (error) => pageErrors.push(`page: ${String(error)}`));
      // The window stays blank until main.js parses the backend port from
      // stdout and calls loadURL.
      await window.waitForURL(/localhost:\d+/, { timeout: 60_000 });
    } catch (e) {
      // Backend never reported a port — surface main.js's log so CI shows why.
      dumpBackendLog('backend boot log (failure)');
      throw e;
    }
  });

  // A failed check says what the window showed, not only that an element was missing.
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    dumpBackendLog(`backend log after "${testInfo.title}"`);
    const text = await window?.evaluate(() => `${location.href}\n${document.body?.innerText?.slice(0, 1500) ?? ''}`)
      .catch((error) => `(no page: ${error})`);
    console.log(`\n===== window after "${testInfo.title}" =====\n${text}\n----- errors -----\n${pageErrors.slice(0, 20).join('\n') || '(none)'}\n=====\n`);
  });

  test.afterAll(async () => {
    if (!app) return;
    const proc = app.process();
    // close() can hang if the app doesn't exit cleanly; cap it, then force-kill
    // the whole process tree (the app + its spawned backend server child), so
    // the Playwright worker teardown doesn't time out.
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ]);
    try {
      if (proc?.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      }
    } catch { /* already gone */ }
  });

  // This suite's purpose is to prove the PACKAGED bundle boots its embedded
  // backend and serves the dashboard — the part that can only fail once
  // packaged. In-app navigation/UI is covered by the reliable gui Playwright
  // suite (Chromium against the built GUI), so we don't re-drive it here where
  // Electron-on-Windows cold-start timing makes nav clicks flaky.
  test('boots the backend and loads the dashboard shell', async () => {
    // The dashboard sidebar renders the brand; an error/blank page would not.
    await expect(window.getByText('ContextSpace', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // The preload bridge reports the backend port the window actually loaded.
    const port = await window.evaluate(() => (window.contextspaceBridge || window.nexusBridge)?.getServerPort());
    expect(port).toBeGreaterThan(0);
  });

  test('ships a readable runtime window icon', async () => {
    const appPath = await app.evaluate(({ app }) => app.getAppPath());
    const iconPath = path.join(appPath, 'assets', 'icon.png');
    const icon = await app.evaluate(({ nativeImage }, runtimeIconPath) => {
      const image = nativeImage.createFromPath(runtimeIconPath);
      const size = image.getSize();
      return { empty: image.isEmpty(), width: size.width, height: size.height };
    }, iconPath);

    expect(icon.empty).toBe(false);
    expect(icon.width).toBeGreaterThan(0);
    expect(icon.height).toBeGreaterThan(0);
  });

  test('does not download spell-check dictionaries on Windows or Linux', async () => {
    const spellcheck = await app.evaluate(({ session }) => ({
      languages: session.defaultSession.getSpellCheckerLanguages(),
      enabled: session.defaultSession.isSpellCheckerEnabled(),
    }));
    if (process.platform === 'darwin') {
      expect(spellcheck.enabled).toBe(true);
    } else {
      expect(spellcheck).toEqual({ languages: [], enabled: false });
    }
  });

  test('exposes a guarded updater IPC status', async () => {
    const state = await window.evaluate(() => (window.contextspaceBridge || window.nexusBridge)?.updates?.getStatus());
    expect(state).toBeTruthy();
    // Dev Electron and browser-like shells can inspect the API but cannot
    // invoke native installation. Linux is supported only when an absolute,
    // existing AppImage is available; the separate CI smoke step launches that
    // actual AppImage. This unpacked boot only exercises the guarded IPC gate.
    const appImage = process.env.APPIMAGE || '';
    const packagedLinux = Boolean(
      packagedExe
      && process.platform === 'linux'
      && path.isAbsolute(appImage)
      && existsSync(appImage),
    );
    const expectedSupported = packagedLinux || Boolean(packagedExe && process.platform === 'win32');
    expect(state.supported).toBe(expectedSupported);
    if (!packagedExe) expect(state.status).toBe('unsupported');
  });
});

test('packaged desktop exposes its bundled CLI without a separate Node installation', async () => {
  test.skip(!packagedExe, 'Requires the packaged desktop runtime and dependency bundle.');
  const entry = path.join(path.dirname(packagedExe), 'resources', 'backend', 'dist', 'index.js');
  expect(existsSync(entry)).toBe(true);
  const result = spawnSync(packagedExe, [entry, 'isolate', '--help'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('isolate');
});
