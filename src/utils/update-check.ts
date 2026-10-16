/**
 * @module utils/update-check
 * Checks for the latest NexusFlow desktop release on GitHub. The server only
 * reports read-only metadata; native downloads/installs belong to Electron or
 * the explicit `nexusflow desktop install` command.
 */

import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

import { loadConfig, saveConfig } from '../core/config.js';
import {
  GITHUB_RELEASE_API_URL,
  GITHUB_RELEASE_PAGE_URL,
  GITHUB_USER_AGENT,
  ENGINE_ID,
  ENGINE_NAME,
  ENGINE_COMMAND,
} from '../core/constants.js';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string | null;
  releaseUrl?: string | null;
  releaseNotes?: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  html_url?: string;
  body: string;
  assets: GitHubAsset[];
}

const RELEASE_PAGE_URL = GITHUB_RELEASE_PAGE_URL;

/**
 * Resolves the current package version by searching for package.json upward
 * from the directory of the executing code.
 */
export function getCurrentVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    let currentDir = __dirname;
    for (let i = 0; i < 5; i++) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {
    // Fallback if filesystem access fails
  }
  return '0.0.0';
}

/**
 * Checks for updates from the GitHub Releases API (antan87/Context-Space).
 * Employs a 24-hour cache unless forced.
 *
 * @param force - If true, ignores the 24-hour cache and fetches immediately.
 * @returns The update status, or null if the check fails (e.g. offline).
 */
export async function checkForUpdates(force = false): Promise<UpdateStatus | null> {
  const currentVersion = getCurrentVersion();
  const config = await loadConfig();

  const now = Date.now();
  const lastCheck = config.lastUpdateCheck ? new Date(config.lastUpdateCheck).getTime() : 0;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // Use cached result if within 24 hours and not forced
  if (!force && lastCheck && (now - lastCheck < ONE_DAY_MS) && config.latestVersion) {
    return {
      currentVersion,
      latestVersion: config.latestVersion,
      updateAvailable: isNewerVersion(currentVersion, config.latestVersion),
      downloadUrl: config.latestDownloadUrl,
      releaseUrl: RELEASE_PAGE_URL,
      releaseNotes: config.latestReleaseNotes,
    };
  }

  try {
    const response = await fetch(GITHUB_RELEASE_API_URL, {
      headers: { 'User-Agent': GITHUB_USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned status ${response.status}`);
    }

    const data = (await response.json()) as Partial<GitHubRelease>;
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid GitHub release response');
    }

    const rawTag = typeof data.tag_name === 'string' ? data.tag_name : '';
    const semverMatch = rawTag.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    if (!semverMatch) {
      throw new Error(`Invalid release tag format: ${rawTag}`);
    }
    const latestVersion = semverMatch[1];
    
    // Resolve a platform-matching release asset for read-only browser links.
    // electron-updater handles packaged desktop downloads independently.
    let downloadUrl: string | null = null;
    if (Array.isArray(data.assets)) {
      const targetAsset = data.assets.find((asset) => {
        if (!asset || typeof asset.name !== 'string') return false;
        const name = asset.name.toLowerCase();
        if (process.platform === 'win32') return name.endsWith('.exe') && name.includes('setup');
        if (process.platform === 'linux') return name.endsWith('.appimage');
        if (process.platform === 'darwin') return name.endsWith('.dmg');
        return false;
      });
      if (targetAsset && typeof targetAsset.browser_download_url === 'string') {
        try {
          const parsed = new URL(targetAsset.browser_download_url);
          if (
            parsed.protocol === 'https:' &&
            (parsed.hostname === 'github.com' ||
              parsed.hostname.endsWith('.github.com') ||
              parsed.hostname === 'objects.githubusercontent.com')
          ) {
            downloadUrl = parsed.toString();
          }
        } catch {}
      }
    }

    const releaseNotes = typeof data.body === 'string' ? data.body.slice(0, 50000) : '';

    // Cache results
    config.lastUpdateCheck = new Date().toISOString();
    config.latestVersion = latestVersion;
    config.latestDownloadUrl = downloadUrl;
    config.latestReleaseNotes = releaseNotes;
    await saveConfig(config);

    let releaseUrl: string = RELEASE_PAGE_URL;
    if (typeof data.html_url === 'string') {
      try {
        const parsed = new URL(data.html_url);
        if (
          parsed.protocol === 'https:' &&
          (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com'))
        ) {
          releaseUrl = parsed.toString();
        }
      } catch {}
    }

    return {
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      downloadUrl,
      releaseUrl,
      releaseNotes,
    };
  } catch {
    // Fallback: If offline or check fails, return cached version status if available
    if (config.latestVersion) {
      return {
        currentVersion,
        latestVersion: config.latestVersion,
        updateAvailable: isNewerVersion(currentVersion, config.latestVersion),
        downloadUrl: config.latestDownloadUrl,
        releaseUrl: RELEASE_PAGE_URL,
        releaseNotes: config.latestReleaseNotes,
      };
    }
    return null;
  }
}

/**
 * Semver comparison over major.minor.patch. Compares only the numeric core so
 * a prerelease/build suffix (e.g. `1.8.0-rc.1`) can't poison a segment into
 * NaN — the previous `.map(Number)` produced NaN for such a part, and every
 * NaN comparison is false, so a real update was silently reported as "up to
 * date". A stable release supersedes a prerelease of the same numeric core.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  if (!current || !latest || current === latest || current === '0.0.0' || current === 'unknown') {
    return false;
  }

  const core = (v: string): number[] =>
    v.trim().replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const currentParts = core(current);
  const latestParts = core(latest);

  for (let i = 0; i < 3; i++) {
    const curr = currentParts[i] ?? 0;
    const lat = latestParts[i] ?? 0;
    if (lat > curr) return true;
    if (curr > lat) return false;
  }

  // Equal numeric core: a stable `latest` supersedes a prerelease `current`.
  return current.includes('-') && !latest.includes('-');
}

/**
 * How to get a newer ContextSpace. It ships only as a release (npm publishing is deprecated), so this is the
 * installer where one exists and the release page elsewhere.
 */
export function engineUpdateAdvice(platform: NodeJS.Platform = process.platform): { command: string | null; sentence: string } {
  if (platform === 'win32' || platform === 'linux') {
    const command = `${ENGINE_COMMAND} desktop install`;
    return { command, sentence: `Run ${command} to update!` };
  }
  return { command: null, sentence: `Download it from ${RELEASE_PAGE_URL}` };
}

/**
 * Prints a clean, premium terminal notification banner if an update is available.
 */
export function printUpdateBanner(status: UpdateStatus): void {
  if (!status.updateAvailable) return;

  const msg = `Update available: ${chalk.red(status.currentVersion)} → ${chalk.green(status.latestVersion)}`;
  const advice = engineUpdateAdvice();
  const runMsg = advice.command ? advice.sentence.replace(advice.command, chalk.cyan(advice.command)) : advice.sentence;

  const cleanMsg = `Update available: ${status.currentVersion} → ${status.latestVersion}`;
  const cleanRunMsg = advice.sentence;
  const width = Math.max(cleanMsg.length, cleanRunMsg.length) + 2;

  const padMsg = ' '.repeat(width - cleanMsg.length);
  const padRunMsg = ' '.repeat(width - cleanRunMsg.length);

  const border = '─'.repeat(width);
  console.log();
  console.log(chalk.yellow(`┌${border}┐`));
  console.log(chalk.yellow(`│ ${msg}${padMsg} │`));
  console.log(chalk.yellow(`│ ${runMsg}${padRunMsg} │`));
  console.log(chalk.yellow(`└${border}┘`));
  console.log();
}

import { execa } from 'execa';
import { PROBE_TIMEOUT_MS } from './probe.js';

export interface ToolUpdateStatus {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  updateCmd: string;
}

let cachedToolsStatus: { timestamp: number; data: ToolUpdateStatus[] } | null = null;
const TOOLS_CACHE_TTL = 60_000; // 1 minute

export async function getToolsStatus(force = false): Promise<ToolUpdateStatus[]> {
  if (!force && cachedToolsStatus && Date.now() - cachedToolsStatus.timestamp < TOOLS_CACHE_TTL) {
    return cachedToolsStatus.data;
  }

  const currentVersion = getCurrentVersion();
  const tools = [
    {
      id: ENGINE_ID,
      name: ENGINE_NAME,
      command: ENGINE_COMMAND,
      npmPackage: '',
      updateCmd: engineUpdateAdvice().command ?? RELEASE_PAGE_URL,
      getCurrent: async () => currentVersion,
      // The release is the only source of a current version; the npm package stopped at 2.39.
      getLatest: async () => (await checkForUpdates())?.latestVersion ?? '',
    },
    {
      id: 'antigravity',
      name: 'Antigravity CLI',
      command: 'agy',
      npmPackage: '',
      updateCmd: 'agy update',
      getCurrent: async () => {
        try {
          const res = await execa('agy', ['--version'], {
            reject: false,
            shell: process.platform === 'win32',
            timeout: PROBE_TIMEOUT_MS,
          });
          if (res.exitCode === 0) return res.stdout.trim();
        } catch {}
        return '';
      }
    },
    {
      id: 'claude',
      name: 'Claude Code CLI',
      command: 'claude',
      npmPackage: '@anthropic-ai/claude-code',
      updateCmd: 'npm install -g @anthropic-ai/claude-code',
      getCurrent: async () => {
        try {
          const res = await execa('claude', ['--version'], {
            reject: false,
            shell: process.platform === 'win32',
            timeout: PROBE_TIMEOUT_MS,
          });
          if (res.exitCode === 0) return res.stdout.trim();
        } catch {}
        return '';
      }
    }
  ];

  const results = await Promise.all(
    tools.map(async (t): Promise<ToolUpdateStatus> => {
      let installed = false;
      let currentVal = '';
      let latestVal = '';

      try {
        currentVal = await t.getCurrent();
        installed = currentVal !== '';
      } catch {}

      if (installed && t.getLatest) {
        try { latestVal = await t.getLatest(); } catch {}
      } else if (installed && t.npmPackage) {
        try {
          const response = await fetch(`https://registry.npmjs.org/${t.npmPackage}/latest`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            const data = await response.json() as { version: string };
            latestVal = data.version;
          }
        } catch {}
      }

      if (!latestVal) {
        latestVal = currentVal || '1.0.0';
      }

      return {
        id: t.id,
        name: t.name,
        command: t.command,
        installed,
        currentVersion: currentVal || 'Not Installed',
        latestVersion: latestVal,
        updateAvailable: installed && isNewerVersion(currentVal, latestVal),
        updateCmd: t.updateCmd,
      };
    })
  );

  cachedToolsStatus = { timestamp: Date.now(), data: results };
  return results;
}
