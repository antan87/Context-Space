/**
 * @module commands/desktop
 * Launches the NexusFlow Electron desktop app and installs the matching
 * packaged desktop release on Windows/Linux.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  BRAND_NAME,
  LEGACY_BRAND_NAME,
  CLI_NAME,
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASE_PAGE_URL,
  DESKTOP_INSTALLER_USER_AGENT,
} from '../core/constants.js';

export { GITHUB_RELEASE_API_URL };

interface ReleaseAsset {
  name: string;
  browser_download_url?: string;
  url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

export interface DesktopInstallResult {
  platform: 'win32' | 'linux';
  assetName: string;
  sha256: string;
  installedPath: string;
  desktopEntryPath?: string;
}

export interface DesktopInstallOptions {
  /** Override process.platform in tests. */
  platform?: NodeJS.Platform;
  /** Override the network client in tests. */
  fetchImpl?: typeof fetch;
  /** Override the release endpoint in tests; production remains fixed. */
  releaseApiUrl?: string;
  /** Override the user home directory in tests. */
  homeDir?: string;
  /** Override the temporary directory in tests. */
  tmpDir?: string;
  /** Override spawning in tests. */
  spawnImpl?: typeof spawn;
  /** Override process.arch in tests; published assets are x64 only. */
  arch?: NodeJS.Architecture;
  /** Override the bundled Linux icon path in tests. */
  iconSourcePath?: string;
}

// Metadata and checksum requests should fail promptly, but an AppImage can be
// hundreds of megabytes. Give the binary transfer its own generous bound so a
// normal GitHub release does not fail merely because it is large or the runner
// is briefly slow.
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const DESKTOP_ASSET_TIMEOUT_MS = 15 * 60_000;
const LINUX_ICON_NAME = BRAND_NAME.toLowerCase();

function isSafeReleaseApiUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const pathname = url.pathname.toLowerCase();
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.github.com'
      && !url.port
      && (pathname === '/repos/antan87/context-space/releases/latest'
        || pathname === '/repos/antan87/nexusflow/releases/latest'
        || pathname === '/repos/antan87/contextspace/releases/latest')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

/**
 * Accept only GitHub release asset URLs. GitHub may redirect browser download
 * URLs to a small set of signed object hosts, so those exact hosts are also
 * allowed. This check is deliberately exported for negative-path tests.
 */
export function isAllowedDesktopReleaseUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'github.com') {
      return /^\/antan87\/(Context-Space|ContextSpace|NexusFlow)\/releases\/download\/[^/]+\/[^/]+$/i.test(url.pathname);
    }
    return host === 'objects.githubusercontent.com'
      || host === 'github-releases.githubusercontent.com'
      || host === 'release-assets.githubusercontent.com';
  } catch {
    return false;
  }
}

function assertSafeAssetName(name: string): string {
  const basename = path.basename(name);
  if (!basename || basename !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Release asset has an unsafe filename: ${name || '(empty)'}`);
  }
  return basename;
}

function isPlatformAsset(name: string, platform: NodeJS.Platform): boolean {
  const lower = name.toLowerCase();
  if (platform === 'win32') return lower.endsWith('.exe') && lower.includes('setup');
  return lower.endsWith('.appimage');
}

function checksumFromSidecar(contents: string): string {
  const match = contents.match(/(?:^|\s)([a-f0-9]{64})(?=\s|$)/i);
  if (!match) throw new Error('Release checksum sidecar is missing a valid SHA-256 digest.');
  return match[1].toLowerCase();
}

export function quoteDesktopExecArg(value: string): string {
  // Desktop-entry Exec values use backslash escapes rather than shell
  // expansion. Keep ordinary paths readable and quote only when needed.
  if (/^[A-Za-z0-9_./:+-]+$/.test(value)) return value;
  return `"${value.replace(/[\\`"$]/g, (character) => `\\${character}`)}"`;
}

async function downloadToFile(response: Response, targetPath: string): Promise<string> {
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
  const hash = createHash('sha256');

  const nodeStream = response.body
    ? Readable.fromWeb(response.body as any)
    : Readable.from(Buffer.from(await response.arrayBuffer()));

  nodeStream.on('data', (chunk) => hash.update(chunk));
  await pipeline(nodeStream, createWriteStream(targetPath, { mode: 0o600 }));
  return hash.digest('hex').toLowerCase();
}

async function fetchRequired(
  responsePromise: Promise<Response>,
  label: string,
  allowedRedirect?: (url: string) => boolean,
): Promise<Response> {
  const response = await responsePromise;
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}.`);
  if (response.url && allowedRedirect && !allowedRedirect(response.url)) {
    throw new Error(`${label} redirected to an untrusted host.`);
  }
  return response;
}

function requestOptions(headers: Record<string, string>, timeoutMs = RELEASE_METADATA_TIMEOUT_MS): RequestInit {
  return { headers, signal: AbortSignal.timeout(timeoutMs) };
}

async function launchWindowsInstaller(
  installerPath: string,
  spawnImpl: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not launch the Windows installer: ${error.message}`));
    };
    if (typeof child.once !== 'function') {
      reject(new Error('Could not launch the Windows installer: installer process did not expose spawn events.'));
      return;
    }
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.unref();
  });
}

async function writeLinuxDesktopEntry(entryPath: string, appImagePath: string, appName: string = BRAND_NAME): Promise<void> {
  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    'Comment=Multi-repo workspace manager for AI-assisted development',
    `Exec=${quoteDesktopExecArg(appImagePath)}`,
    `Icon=${LINUX_ICON_NAME}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    `StartupWMClass=${appName}`,
    '',
  ].join('\n');
  await writeFile(entryPath, contents, { encoding: 'utf8', mode: 0o644 });
}

/**
 * Download and install the latest checksum-verified desktop asset. This is
 * intentionally explicit (`nexusflow desktop install`): npm install and app
 * startup never invoke it.
 */
export async function installDesktop(options: DesktopInstallOptions = {}): Promise<DesktopInstallResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(`Desktop installer is unsupported on ${platform}. Install the Windows or Linux release from ${GITHUB_RELEASE_PAGE_URL}.`);
  }
  const arch = options.arch ?? process.arch;
  if (arch !== 'x64') {
    throw new Error(`Desktop installer is unsupported on ${platform}/${arch}; published desktop assets are x64 only.`);
  }

  const iconSourcePath = platform === 'linux'
    ? options.iconSourcePath ?? getDesktopIconPath()
    : undefined;
  if (iconSourcePath) {
    const iconInfo = await stat(iconSourcePath).catch(() => undefined);
    if (!iconInfo?.isFile()) {
      throw new Error(`The bundled ${BRAND_NAME} desktop icon is unavailable at ${iconSourcePath}.`);
    }
  }

  const releaseApiUrl = options.releaseApiUrl ?? GITHUB_RELEASE_API_URL;
  if (!isSafeReleaseApiUrl(releaseApiUrl)) {
    throw new Error('Refusing to contact an untrusted GitHub release host.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiResponse = await fetchRequired(
    fetchImpl(releaseApiUrl, requestOptions({ 'User-Agent': DESKTOP_INSTALLER_USER_AGENT, Accept: 'application/vnd.github+json' })),
    'GitHub release',
    isSafeReleaseApiUrl,
  );
  const release = await apiResponse.json() as GitHubRelease;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((candidate) => typeof candidate.name === 'string' && isPlatformAsset(candidate.name, platform));
  if (!asset || !asset.browser_download_url) {
    throw new Error(`The latest GitHub release has no ${platform === 'win32' ? 'Windows NSIS installer' : 'Linux AppImage'} asset.`);
  }
  const assetName = assertSafeAssetName(asset.name);
  if (!isAllowedDesktopReleaseUrl(asset.browser_download_url)) {
    throw new Error('Refusing to download a desktop asset from an untrusted host.');
  }

  const sidecar = assets.find((candidate) => candidate.name === `${assetName}.sha256`);
  if (!sidecar || !sidecar.browser_download_url) {
    throw new Error(`Release is missing the required SHA-256 sidecar for ${assetName}.`);
  }
  if (!isAllowedDesktopReleaseUrl(sidecar.browser_download_url)) {
    throw new Error('Refusing to download a checksum sidecar from an untrusted host.');
  }

  const tempRoot = await mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), `${CLI_NAME}-desktop-`));
  const downloadedPath = path.join(tempRoot, assetName);
  let stagedPath: string | undefined;
  let stagedIconPath: string | undefined;
  let stagedDesktopEntryPath: string | undefined;
  try {
    const sidecarResponse = await fetchRequired(
      fetchImpl(sidecar.browser_download_url, requestOptions({ 'User-Agent': DESKTOP_INSTALLER_USER_AGENT })),
      'SHA-256 sidecar',
      isAllowedDesktopReleaseUrl,
    );
    const expectedHash = checksumFromSidecar(await sidecarResponse.text());
    const assetResponse = await fetchRequired(
      fetchImpl(asset.browser_download_url, requestOptions({ 'User-Agent': DESKTOP_INSTALLER_USER_AGENT }, DESKTOP_ASSET_TIMEOUT_MS)),
      'Desktop asset',
      isAllowedDesktopReleaseUrl,
    );
    const actualHash = await downloadToFile(assetResponse, downloadedPath);
    if (actualHash !== expectedHash) {
      throw new Error(`SHA-256 checksum mismatch for ${assetName} (expected ${expectedHash}, got ${actualHash}).`);
    }

    if (platform === 'win32') {
      await launchWindowsInstaller(downloadedPath, options.spawnImpl ?? spawn);
      return { platform, assetName, sha256: actualHash, installedPath: downloadedPath };
    }

    const homeDir = options.homeDir ?? os.homedir();
    const appName = assetName.toLowerCase().startsWith(CLI_NAME) || assetName.toLowerCase().startsWith(BRAND_NAME.toLowerCase())
      ? BRAND_NAME
      : LEGACY_BRAND_NAME;
    const legacyPath = path.join(homeDir, '.local', 'share', LEGACY_BRAND_NAME.toLowerCase(), `${LEGACY_BRAND_NAME}.AppImage`);
    const legacyInstalled = appName === BRAND_NAME && await stat(legacyPath).then((info) => info.isFile()).catch(() => false);
    const installName = legacyInstalled ? LEGACY_BRAND_NAME : appName;
    const installDirName = installName.toLowerCase();
    const installDir = path.join(homeDir, '.local', 'share', installDirName);
    const desktopDir = path.join(homeDir, '.local', 'share', 'applications');
    const iconDir = path.join(homeDir, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
    const iconPath = path.join(iconDir, `${LINUX_ICON_NAME}.png`);
    // Keep the launcher target stable across releases. A versioned filename
    // would leave an old desktop entry behind and make updates appear to
    // succeed while launching the previous AppImage.
    const installedPath = path.join(installDir, `${installName}.AppImage`);
    const desktopEntryPath = path.join(desktopDir, `${installName.toLowerCase()}.desktop`);
    const stagingSuffix = `.tmp-${process.pid}-${Date.now()}`;
    stagedPath = `${installedPath}${stagingSuffix}`;
    stagedIconPath = `${iconPath}${stagingSuffix}`;
    stagedDesktopEntryPath = `${desktopEntryPath}${stagingSuffix}`;
    await mkdir(installDir, { recursive: true, mode: 0o755 });
    await mkdir(desktopDir, { recursive: true, mode: 0o755 });
    await mkdir(iconDir, { recursive: true, mode: 0o755 });
    await copyFile(downloadedPath, stagedPath);
    await chmod(stagedPath, 0o755);
    await copyFile(iconSourcePath!, stagedIconPath);
    await chmod(stagedIconPath, 0o644);
    await writeLinuxDesktopEntry(stagedDesktopEntryPath, installedPath, appName);
    await rename(stagedPath, installedPath);
    await rename(stagedIconPath, iconPath);
    await rename(stagedDesktopEntryPath, desktopEntryPath);
    await rm(tempRoot, { recursive: true, force: true });
    return { platform, assetName, sha256: actualHash, installedPath, desktopEntryPath };
  } catch (error) {
    // A failed copy/rename must not damage the currently installed AppImage.
    // The temporary sibling is safe to remove independently.
    if (stagedPath) await rm(stagedPath, { force: true }).catch(() => {});
    if (stagedIconPath) await rm(stagedIconPath, { force: true }).catch(() => {});
    if (stagedDesktopEntryPath) await rm(stagedDesktopEntryPath, { force: true }).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Resolves the repo root directory.
 *
 * The Electron `desktop/` project lives inside this repo:
 *
 *   ContextSpace/            ← repo root
 *     dist/commands/desktop.js   ← this file at runtime
 *     desktop/                   ← Electron desktop app (main.js)
 *
 * This file compiles to `ContextSpace/dist/commands/desktop.js`, so the repo
 * root is two levels up (and `desktop/` sits beside `dist/`).
 */
function resolveRepoRoot(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '..', '..');
}

function getDesktopIconPath(): string {
  return path.join(resolveRepoRoot(), 'desktop', 'assets', 'icon.png');
}

function getDesktopDir(): string {
  return path.join(resolveRepoRoot(), 'desktop');
}

/**
 * Launches the ContextSpace Electron desktop app via `npm start` in the desktop
 * project. Spawns detached so the CLI returns while the app keeps running.
 */
export async function desktopCommand(): Promise<void> {
  console.log(chalk.bold.cyan(`\n🖥️  ${BRAND_NAME} — Desktop App\n`));

  const desktopDir = getDesktopDir();

  // 1. If running inside a source checkout where desktop/main.js exists:
  if (existsSync(path.join(desktopDir, 'main.js'))) {
    if (!existsSync(path.join(desktopDir, 'node_modules'))) {
      console.log(chalk.yellow('Desktop dependencies are not installed.\n'));
      console.log(chalk.white('Install them first:\n'));
      console.log(chalk.green('  cd desktop && npm install\n'));
      return;
    }

    console.log(chalk.dim('Launching the desktop app from source checkout…'));

    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npm.cmd' : 'npm', ['start'], {
      cwd: desktopDir,
      detached: true,
      stdio: 'ignore',
      shell: isWin,
      windowsHide: true,
    });

    child.on('error', (err) => {
      console.error(chalk.red(`  ✖ Failed to launch desktop app: ${err.message}`));
    });

    child.unref();

    console.log(chalk.green('Desktop app launched.\n'));
    console.log(chalk.dim('(Ensure the CLI is built — `npm run build` — so the app can start its backend.)\n'));
    return;
  }

  // 2. Check for an installed packaged desktop AppImage on Linux
  if (process.platform === 'linux') {
    const homeDir = os.homedir();
    const candidates = [
      path.join(homeDir, '.local', 'share', 'contextspace', 'ContextSpace.AppImage'),
      path.join(homeDir, '.local', 'share', 'nexusflow', 'NexusFlow.AppImage'),
    ];
    const installed = candidates.find((p) => existsSync(p));
    if (installed) {
      console.log(chalk.dim(`Launching installed desktop app from:\n  ${installed}…`));
      const child = spawn(installed, [], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        console.error(chalk.red(`  ✖ Failed to launch installed desktop app: ${err.message}`));
      });
      child.unref();
      console.log(chalk.green('Desktop app launched.\n'));
      return;
    }
  }

  // 3. Neither source nor installed app found: provide actionable instructions
  console.log(chalk.yellow('No installed desktop application or source checkout found.\n'));
  console.log(chalk.white('To install the desktop application, run:'));
  console.log(chalk.green(`  ${CLI_NAME} desktop install\n`));
  if (process.platform === 'linux') {
    console.log(chalk.white('Once installed, you can also launch ContextSpace from:'));
    console.log(chalk.cyan('  • Application menu: ') + chalk.white('Activities / App Grid (press Super key, search for ContextSpace)'));
    console.log(chalk.cyan('  • Terminal:         ') + chalk.green('gtk-launch contextspace') + chalk.white(' or execute the AppImage directly\n'));
  }
  console.log(chalk.dim('From a source repository checkout, run:'));
  console.log(chalk.dim('  cd desktop && npm install && npm start\n'));
}

/** Explicit, user-initiated desktop installer command. */
export async function desktopInstallCommand(): Promise<void> {
  console.log(chalk.bold.cyan(`\n🖥️  ${BRAND_NAME} — Desktop Installer\n`));
  const result = await installDesktop();
  if (result.platform === 'win32') {
    console.log(chalk.green(`✔ Downloaded and verified ${result.assetName}. Launching the Windows installer…`));
  } else {
    const desktopFile = result.desktopEntryPath
      ? path.basename(result.desktopEntryPath, '.desktop')
      : 'contextspace';
    console.log(chalk.green(`✔ Installed and verified ${result.assetName}`));
    console.log(chalk.dim(`  AppImage:      ${result.installedPath}`));
    if (result.desktopEntryPath) {
      console.log(chalk.dim(`  Desktop entry: ${result.desktopEntryPath}`));
    }
    console.log(chalk.bold('\nTo start ContextSpace Desktop:\n'));
    console.log(chalk.cyan('  • Application menu: ') + chalk.white('Open Activities (press Super / Windows key), search for ') + chalk.bold.white(BRAND_NAME) + chalk.white(', and click to launch.'));
    console.log(chalk.cyan('  • Terminal:         ') + chalk.white('Run ') + chalk.green(`gtk-launch ${desktopFile}`) + chalk.white(' or execute:\n') + chalk.dim(`                      ${result.installedPath}\n`));
    console.log(chalk.cyan(`  • CLI shortcut:     `) + chalk.white('Run ') + chalk.green(`${CLI_NAME} desktop`) + chalk.white(' anytime.\n'));
    console.log(chalk.dim('Note: This runs the packaged desktop application. If developing from a source checkout,'));
    console.log(chalk.dim('use `npm run build && cd desktop && npm start` instead.\n'));
  }
}
