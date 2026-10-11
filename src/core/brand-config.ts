/**
 * @module core/brand-config
 * Centralized, strongly-typed Brand and Naming Configuration System.
 *
 * Governs all product identities, CLI binary names, aliases, manifest files,
 * lockfiles, markdown artifacts, environment variables, sentinels, and fallback
 * chains.
 *
 * Future rebrands or white-label naming changes only require updating this
 * configuration structure.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface FileNamingPair {
  /** The canonical, current filename. */
  readonly primary: string;
  /** Legacy fallback filename for backward compatibility. */
  readonly legacy: string;
}

export interface BrandConfigSchema {
  readonly identity: {
    readonly name: string;
    readonly shortName: string;
    readonly legacyName: string;
    readonly cliName: string;
    readonly cliAliases: readonly string[];
    readonly tagline: string;
  };
  readonly files: {
    readonly manifest: FileNamingPair;
    readonly lock: FileNamingPair;
    readonly knowledge: FileNamingPair;
    readonly plan: FileNamingPair;
    readonly overview: FileNamingPair;
    readonly handoff: FileNamingPair;
    readonly cursorRule: FileNamingPair;
    readonly configDir: FileNamingPair;
    readonly chatLedger: FileNamingPair;
    readonly state: FileNamingPair;
    readonly runningState: FileNamingPair;
    readonly analysisCache: FileNamingPair;
    readonly logsDir: FileNamingPair;
    readonly mutationLock: FileNamingPair;
  };
  readonly env: {
    readonly home: readonly string[];
    readonly port: readonly string[];
    readonly packagedExe: readonly string[];
    readonly desktopLog: readonly string[];
    readonly desktopUri: readonly string[];
  };
  readonly mcp: {
    readonly serverName: string;
    readonly legacyServerName: string;
    readonly adapterServerName: string;
    readonly legacyAdapterServerName: string;
    readonly packageName: string;
    readonly legacyPackageName: string;
  };
  readonly extension: {
    readonly id: string;
    readonly legacyId: string;
    readonly commandPrefix: string;
    readonly legacyCommandPrefix: string;
  };
  readonly desktop: {
    readonly appId: string;
    readonly productName: string;
    readonly legacyProductName: string;
    readonly installerName: string;
    readonly legacyInstallerName: string;
    readonly readyTokenPrefixes: readonly string[];
  };
  readonly sentinels: {
    readonly freshnessStart: readonly string[];
    readonly freshnessEnd: readonly string[];
  };
  readonly resources: {
    readonly skillsDir: string;
    readonly agentsDir: string;
    readonly workflowsDir: string;
    readonly locksDir: string;
    readonly catalogLockFile: string;
    readonly adminLockFile: string;
    readonly managedOwnershipName: string;
    readonly legacyOwnershipName: string;
    readonly metadataKey: string;
    readonly legacyMetadataKey: string;
    readonly packageLoopSkillId: string;
    readonly legacyPackageLoopSkillId: string;
    readonly releaseOrderingSkillId: string;
    readonly legacyReleaseOrderingSkillId: string;
  };
  readonly stores: {
    readonly config: string;
    readonly projects: string;
    readonly schedules: string;
    readonly categories: string;
  };
  readonly github: {
    readonly owner: string;
    readonly repo: string;
    readonly legacyRepo: string;
    readonly repoUrl: string;
    readonly legacyRepoUrl: string;
    readonly releaseApiUrl: string;
    readonly legacyReleaseApiUrl: string;
    readonly releasePageUrl: string;
    readonly legacyReleasePageUrl: string;
    readonly userAgent: string;
    readonly legacyUserAgent: string;
    readonly desktopInstallerUserAgent: string;
  };
  readonly engine: {
    readonly id: string;
    readonly legacyId: string;
    readonly name: string;
    readonly command: string;
    readonly legacyCommand: string;
    readonly npmPackage: string;
    readonly legacyNpmPackage: string;
  };
  readonly terminal: {
    readonly titlePrefix: string;
    readonly legacyTitlePrefix: string;
    readonly defaultTitle: string;
    readonly legacyDefaultTitle: string;
    readonly runnerTitle: string;
    readonly legacyRunnerTitle: string;
  };
  readonly workrooms: {
    readonly bootstrapHeaders: readonly string[];
    readonly bootstrapCookies: readonly string[];
    readonly defaultBootstrapHeader: string;
    readonly defaultBootstrapCookie: string;
    readonly inviteProtocols: readonly string[];
    readonly defaultInviteProtocol: string;
    readonly roomExportExtension: string;
    readonly legacyRoomExportExtension: string;
  };
  readonly theme: {
    readonly primary: string;
    readonly sunset: {
      readonly gold: string;
      readonly coral: string;
      readonly hibiscus: string;
      readonly indigo: string;
    };
    readonly aurora?: {
      readonly first: string;
      readonly middle: string;
      readonly last: string;
      readonly depth: string;
    };
    readonly forest?: {
      readonly first: string;
      readonly middle: string;
      readonly last: string;
      readonly depth: string;
    };
    readonly nebula?: {
      readonly first: string;
      readonly middle: string;
      readonly last: string;
      readonly depth: string;
    };
    readonly glacier?: {
      readonly first: string;
      readonly middle: string;
      readonly last: string;
      readonly depth: string;
    };
    readonly dark: {
      readonly background: string;
      readonly foreground: string;
      readonly card: string;
      readonly popover: string;
      readonly border: string;
    };
    readonly light: {
      readonly background: string;
      readonly foreground: string;
      readonly card: string;
      readonly popover: string;
      readonly border: string;
    };
  };
}

export const BRAND_CONFIG: BrandConfigSchema = {
  identity: {
    name: 'ContextSpace',
    shortName: 'CS',
    legacyName: 'NexusFlow',
    cliName: 'ctxspace',
    cliAliases: ['contextspace', 'cs', 'nexusflow'],
    tagline: 'Deterministic AI Context Engine & Multi-Repo Workspace Orchestrator',
  },
  files: {
    manifest: {
      primary: 'contextspace.json',
      legacy: 'nexusflow.json',
    },
    lock: {
      primary: 'contextspace.lock',
      legacy: 'nexusflow.lock',
    },
    knowledge: {
      primary: 'contextspace-knowledge.md',
      legacy: 'nexusflow-knowledge.md',
    },
    plan: {
      primary: 'contextspace-plan.md',
      legacy: 'nexusflow-plan.md',
    },
    overview: {
      primary: 'contextspace-overview.md',
      legacy: 'nexusflow-overview.md',
    },
    handoff: {
      primary: 'contextspace-handoff.md',
      legacy: 'nexusflow-handoff.md',
    },
    cursorRule: {
      primary: '.cursor/rules/contextspace.mdc',
      legacy: '.cursor/rules/nexusflow.mdc',
    },
    configDir: {
      primary: '.contextspace',
      legacy: '.nexusflow',
    },
    chatLedger: {
      primary: '.contextspace/chat.jsonl',
      legacy: '.nexusflow/chat.jsonl',
    },
    state: {
      primary: '.contextspace-state.json',
      legacy: '.nexusflow-state.json',
    },
    runningState: {
      primary: '.contextspace-running.json',
      legacy: '.nexusflow-running.json',
    },
    analysisCache: {
      primary: '.contextspace-analysis-cache.json',
      legacy: '.nexusflow-analysis-cache.json',
    },
    logsDir: {
      primary: '.contextspace-logs',
      legacy: '.nexusflow-logs',
    },
    mutationLock: {
      primary: '.contextspace-mutation.lock',
      legacy: '.nexusflow-mutation.lock',
    },
  },
  env: {
    home: ['CONTEXTSPACE_HOME', 'NEXUSFLOW_HOME'],
    port: ['CONTEXTSPACE_PORT', 'CS_PORT', 'NEXUSFLOW_PORT', 'NF_PORT'],
    packagedExe: ['CONTEXTSPACE_PACKAGED_EXE', 'NEXUSFLOW_PACKAGED_EXE'],
    desktopLog: ['CONTEXTSPACE_DESKTOP_LOG', 'NEXUSFLOW_DESKTOP_LOG'],
    desktopUri: ['CONTEXTSPACE_DESKTOP_URI', 'NEXUSFLOW_DESKTOP_URI'],
  },
  mcp: {
    serverName: 'contextspace-mcp',
    legacyServerName: 'nexusflow-mcp',
    adapterServerName: 'contextspace',
    legacyAdapterServerName: 'nexusflow',
    packageName: '@mrpatronz/nexusflow',
    legacyPackageName: '@mrpatronz/nexusflow',
  },
  extension: {
    id: 'contextspace.contextspace-vscode',
    legacyId: 'nexusflow.nexusflow-vscode',
    commandPrefix: 'contextspace',
    legacyCommandPrefix: 'nexusflow',
  },
  desktop: {
    appId: 'se.hogia.nexusflow',
    productName: 'ContextSpace',
    legacyProductName: 'NexusFlow',
    installerName: 'ContextSpaceSetup.exe',
    legacyInstallerName: 'NexusFlowSetup.exe',
    readyTokenPrefixes: ['CONTEXTSPACE_READY_PORT', 'NEXUSFLOW_READY_PORT'],
  },
  sentinels: {
    freshnessStart: ['CONTEXTSPACE:FRESHNESS:START', 'NEXUSFLOW:FRESHNESS:START'],
    freshnessEnd: ['CONTEXTSPACE:FRESHNESS:END', 'NEXUSFLOW:FRESHNESS:END'],
  },
  resources: {
    skillsDir: 'skills',
    agentsDir: 'agents',
    workflowsDir: 'workflows',
    locksDir: '.locks',
    catalogLockFile: 'resource-catalog.lock',
    adminLockFile: 'resource-administration.lock',
    managedOwnershipName: 'ContextSpace',
    legacyOwnershipName: 'NexusFlow',
    metadataKey: 'contextspace',
    legacyMetadataKey: 'nexusflow',
    packageLoopSkillId: 'contextspace-local-package-loop',
    legacyPackageLoopSkillId: 'nexusflow-local-package-loop',
    releaseOrderingSkillId: 'contextspace-release-ordering',
    legacyReleaseOrderingSkillId: 'nexusflow-release-ordering',
  },
  stores: {
    config: 'config.json',
    projects: 'projects.json',
    schedules: 'schedules.json',
    categories: 'categories.json',
  },
  github: {
    owner: 'antan87',
    repo: 'Context-Space',
    legacyRepo: 'NexusFlow',
    repoUrl: 'https://github.com/antan87/Context-Space',
    legacyRepoUrl: 'https://github.com/antan87/NexusFlow',
    releaseApiUrl: 'https://api.github.com/repos/antan87/Context-Space/releases/latest',
    legacyReleaseApiUrl: 'https://api.github.com/repos/antan87/NexusFlow/releases/latest',
    releasePageUrl: 'https://github.com/antan87/Context-Space/releases/latest',
    legacyReleasePageUrl: 'https://github.com/antan87/NexusFlow/releases/latest',
    userAgent: 'ContextSpace-Updater',
    legacyUserAgent: 'NexusFlow-Updater',
    desktopInstallerUserAgent: 'ContextSpace-Desktop-Installer',
  },
  engine: {
    id: 'contextspace',
    legacyId: 'nexusflow',
    name: 'ContextSpace Engine',
    command: 'ctxspace',
    legacyCommand: 'nexusflow',
    npmPackage: '@mrpatronz/nexusflow',
    legacyNpmPackage: '@mrpatronz/nexusflow',
  },
  terminal: {
    titlePrefix: 'ContextSpace:',
    legacyTitlePrefix: 'NexusFlow:',
    defaultTitle: 'ContextSpace Terminal',
    legacyDefaultTitle: 'NexusFlow Terminal',
    runnerTitle: 'ContextSpace Runner',
    legacyRunnerTitle: 'NexusFlow Runner',
  },
  workrooms: {
    bootstrapHeaders: ['x-contextspace-workroom-bootstrap', 'x-nexusflow-workroom-bootstrap'],
    bootstrapCookies: ['contextspace_workroom_bootstrap', 'nexusflow_workroom_bootstrap'],
    defaultBootstrapHeader: 'X-ContextSpace-Workroom-Bootstrap',
    defaultBootstrapCookie: 'contextspace_workroom_bootstrap',
    inviteProtocols: ['contextspace:', 'nexusflow:'],
    defaultInviteProtocol: 'contextspace:',
    roomExportExtension: '.contextspace-room.json',
    legacyRoomExportExtension: '.nexusflow-room.json',
  },
  theme: {
    primary: '#F97316',
    sunset: {
      gold: '#FDE047',
      coral: '#FB923C',
      hibiscus: '#F43F5E',
      indigo: '#6366F1',
    },
    aurora: {
      first: '#5EEAD4',
      middle: '#22D3EE',
      last: '#818CF8',
      depth: '#6366F1',
    },
    forest: {
      first: '#86EFAC',
      middle: '#22C55E',
      last: '#14B8A6',
      depth: '#0F766E',
    },
    nebula: {
      first: '#F472B6',
      middle: '#C084FC',
      last: '#818CF8',
      depth: '#4F46E5',
    },
    glacier: {
      first: '#93C5FD',
      middle: '#38BDF8',
      last: '#60A5FA',
      depth: '#2563EB',
    },
    dark: {
      background: '#0A0812',
      foreground: '#F8FAFC',
      card: '#140F22',
      popover: '#181228',
      border: 'rgba(251, 146, 60, 0.14)',
    },
    light: {
      background: '#FAF8F6',
      foreground: '#0F172A',
      card: '#FFFFFF',
      popover: '#FFFFFF',
      border: 'rgba(234, 88, 12, 0.10)',
    },
  },
} as const;

export type FileKey = keyof typeof BRAND_CONFIG.files;

// ─── Typed Resolution Helpers ────────────────────────────────────────────────

/**
 * Returns the first non-empty value from a list of environment variable names.
 */
export function resolveFirstEnv(envKeys: readonly string[]): string | undefined {
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val !== 'undefined' && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

/**
 * Resolves the ContextSpace global home directory.
 * Priority: CONTEXTSPACE_HOME -> NEXUSFLOW_HOME -> ~/.contextspace -> ~/.nexusflow -> ~/.contextspace
 */
export function resolveBrandHomeDir(): string {
  const csHome = process.env.CONTEXTSPACE_HOME?.trim();
  const nfHome = process.env.NEXUSFLOW_HOME?.trim();

  if (csHome && existsSync(path.resolve(csHome))) return path.resolve(csHome);
  if (nfHome && existsSync(path.resolve(nfHome)) && !csHome) return path.resolve(nfHome);
  if (csHome) return path.resolve(csHome);
  if (nfHome) return path.resolve(nfHome);

  const primary = path.join(os.homedir(), BRAND_CONFIG.files.configDir.primary);
  const legacy = path.join(os.homedir(), BRAND_CONFIG.files.configDir.legacy);
  if (existsSync(primary)) return primary;
  if (existsSync(legacy)) return legacy;
  return primary;
}

/**
 * Resolves the path of a file key within a workspace, checking primary then legacy.
 * If neither exists, returns the canonical primary path.
 */
export async function resolveWorkspaceFilePath(
  workspaceDir: string,
  key: FileKey,
): Promise<{ path: string; isLegacy: boolean; exists: boolean }> {
  const pair = BRAND_CONFIG.files[key];
  const primaryPath = path.join(workspaceDir, pair.primary);
  try {
    await fs.access(primaryPath);
    return { path: primaryPath, isLegacy: false, exists: true };
  } catch {
    const legacyPath = path.join(workspaceDir, pair.legacy);
    try {
      await fs.access(legacyPath);
      return { path: legacyPath, isLegacy: true, exists: true };
    } catch {
      return { path: primaryPath, isLegacy: false, exists: false };
    }
  }
}

/**
 * Synchronously resolves a workspace file path with fallback to legacy.
 */
export function resolveWorkspaceFilePathSync(
  workspaceDir: string,
  key: FileKey,
): { path: string; isLegacy: boolean; exists: boolean } {
  const pair = BRAND_CONFIG.files[key];
  const primaryPath = path.join(workspaceDir, pair.primary);
  if (existsSync(primaryPath)) {
    return { path: primaryPath, isLegacy: false, exists: true };
  }
  const legacyPath = path.join(workspaceDir, pair.legacy);
  if (existsSync(legacyPath)) {
    return { path: legacyPath, isLegacy: true, exists: true };
  }
  return { path: primaryPath, isLegacy: false, exists: false };
}

/**
 * Synchronously resolves the workspace configuration directory (.contextspace vs .nexusflow).
 */
export function resolveWorkspaceConfigDir(
  workspaceDir: string,
): { path: string; isLegacy: boolean; exists: boolean } {
  return resolveWorkspaceFilePathSync(workspaceDir, 'configDir');
}

export interface WorkspaceChatLedgerInfo {
  /** The authoritative file path for reading/writing the workspace chat ledger. */
  chatPath: string;
  /** Directory containing the authoritative chat ledger. */
  chatDir: string;
  /** True if resolving to legacy path (.nexusflow/chat.jsonl). */
  isLegacy: boolean;
  /** True if the chatPath file exists on disk. */
  exists: boolean;
  /** All existing ledger files in the workspace (legacy first, then primary), for complete history. */
  readPaths: string[];
}

/**
 * Synchronously resolves the workspace chat ledger path and directory.
 * Preserves existing legacy history when present, and supports mixed or native workspaces.
 */
export function resolveWorkspaceChatLedgerSync(
  workspaceDir: string,
): WorkspaceChatLedgerInfo {
  const primaryDir = path.join(workspaceDir, BRAND_CONFIG.files.configDir.primary);
  const legacyDir = path.join(workspaceDir, BRAND_CONFIG.files.configDir.legacy);

  const primaryChat = path.join(workspaceDir, BRAND_CONFIG.files.chatLedger.primary);
  const legacyChat = path.join(workspaceDir, BRAND_CONFIG.files.chatLedger.legacy);

  const primaryExists = existsSync(primaryChat);
  const legacyExists = existsSync(legacyChat);
  const primaryDirExists = existsSync(primaryDir);
  const legacyDirExists = existsSync(legacyDir);

  const readPaths: string[] = [];
  if (legacyExists) readPaths.push(legacyChat);
  if (primaryExists && !readPaths.includes(primaryChat)) readPaths.push(primaryChat);

  // 1. If primary chat file exists, use it as the authoritative ledger.
  if (primaryExists) {
    return {
      chatPath: primaryChat,
      chatDir: primaryDir,
      isLegacy: false,
      exists: true,
      readPaths,
    };
  }

  // 2. If legacy chat file exists, preserve existing history and use it.
  if (legacyExists) {
    return {
      chatPath: legacyChat,
      chatDir: legacyDir,
      isLegacy: true,
      exists: true,
      readPaths,
    };
  }

  // 3. Neither file exists yet.
  // If only legacy directory exists, place in legacy directory.
  if (legacyDirExists && !primaryDirExists) {
    return {
      chatPath: legacyChat,
      chatDir: legacyDir,
      isLegacy: true,
      exists: false,
      readPaths,
    };
  }

  // 4. In native, mixed, or fresh workspaces without an existing ledger, default to primary (.contextspace).
  return {
    chatPath: primaryChat,
    chatDir: primaryDir,
    isLegacy: false,
    exists: false,
    readPaths,
  };
}

/**
 * Asynchronously resolves the workspace chat ledger path and directory.
 * Preserves existing legacy history when present, and supports mixed or native workspaces.
 */
export async function resolveWorkspaceChatLedger(
  workspaceDir: string,
): Promise<WorkspaceChatLedgerInfo> {
  const primaryDir = path.join(workspaceDir, BRAND_CONFIG.files.configDir.primary);
  const legacyDir = path.join(workspaceDir, BRAND_CONFIG.files.configDir.legacy);

  const primaryChat = path.join(workspaceDir, BRAND_CONFIG.files.chatLedger.primary);
  const legacyChat = path.join(workspaceDir, BRAND_CONFIG.files.chatLedger.legacy);

  const [primaryExists, legacyExists, primaryDirExists, legacyDirExists] = await Promise.all([
    fs.access(primaryChat).then(() => true).catch(() => false),
    fs.access(legacyChat).then(() => true).catch(() => false),
    fs.access(primaryDir).then(() => true).catch(() => false),
    fs.access(legacyDir).then(() => true).catch(() => false),
  ]);

  const readPaths: string[] = [];
  if (legacyExists) readPaths.push(legacyChat);
  if (primaryExists && !readPaths.includes(primaryChat)) readPaths.push(primaryChat);

  if (primaryExists) {
    return {
      chatPath: primaryChat,
      chatDir: primaryDir,
      isLegacy: false,
      exists: true,
      readPaths,
    };
  }

  if (legacyExists) {
    return {
      chatPath: legacyChat,
      chatDir: legacyDir,
      isLegacy: true,
      exists: true,
      readPaths,
    };
  }

  if (legacyDirExists && !primaryDirExists) {
    return {
      chatPath: legacyChat,
      chatDir: legacyDir,
      isLegacy: true,
      exists: false,
      readPaths,
    };
  }

  return {
    chatPath: primaryChat,
    chatDir: primaryDir,
    isLegacy: false,
    exists: false,
    readPaths,
  };
}

/**
 * Reads all messages from the workspace chat ledger, combining historical legacy messages
 * and primary messages if both exist, deduplicating by ID, and sorting chronologically.
 */
export async function readWorkspaceChatMessages(
  workspaceDir: string,
  limit?: number,
): Promise<{ messages: any[]; ledgerInfo: WorkspaceChatLedgerInfo }> {
  const ledgerInfo = await resolveWorkspaceChatLedger(workspaceDir);
  const pathsToRead = ledgerInfo.readPaths.length > 0 ? ledgerInfo.readPaths : (ledgerInfo.exists ? [ledgerInfo.chatPath] : []);

  const allMessages: any[] = [];
  const seenIds = new Set<string>();

  for (const filePath of pathsToRead) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            const id = parsed.id || `${parsed.timestamp || ''}-${parsed.message || ''}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              allMessages.push(parsed);
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    } catch {
      // ignore unreadable file
    }
  }

  allMessages.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return 0;
  });

  const messages = typeof limit === 'number' && limit > 0 ? allMessages.slice(-limit) : allMessages;
  return { messages, ledgerInfo };
}

/**
 * Resolves a durable global state path under the home config directory,
 * falling back to ~/.nexusflow/<relPath> if it exists and ~/.contextspace/<relPath> does not.
 */
export function resolveGlobalDurablePath(relPath: string): string {
  const csHome = process.env.CONTEXTSPACE_HOME?.trim();
  const nfHome = process.env.NEXUSFLOW_HOME?.trim();

  if (csHome && existsSync(path.join(path.resolve(csHome), relPath))) {
    return path.join(path.resolve(csHome), relPath);
  }
  if (nfHome && existsSync(path.join(path.resolve(nfHome), relPath))) {
    return path.join(path.resolve(nfHome), relPath);
  }
  if (csHome) {
    return path.join(path.resolve(csHome), relPath);
  }
  if (nfHome) {
    return path.join(path.resolve(nfHome), relPath);
  }

  const primary = path.join(os.homedir(), BRAND_CONFIG.files.configDir.primary, relPath);
  if (existsSync(primary)) return primary;
  const legacy = path.join(os.homedir(), BRAND_CONFIG.files.configDir.legacy, relPath);
  if (existsSync(legacy)) return legacy;
  return primary;
}

/**
 * Generates the PM2 prefix scoped to a workspace hash.
 */
export function getPm2ProcessPrefix(workspacePath: string): string {
  const base = path.basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
  const hash = createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 8);
  return `${BRAND_CONFIG.identity.cliName}-${base}-${hash}-`;
}

/**
 * Generates stdout tokens for the desktop readiness handshake.
 */
export function getDesktopReadyTokens(port: number): string[] {
  return BRAND_CONFIG.desktop.readyTokenPrefixes.map((prefix) => `${prefix}=${port}`);
}

/**
 * Returns a RegExp matching any supported desktop ready port token.
 */
export function getDesktopReadyPortRegex(): RegExp {
  const prefixes = BRAND_CONFIG.desktop.readyTokenPrefixes.join('|');
  return new RegExp(`(?:${prefixes})=(\\d+)`);
}

/**
 * Returns a RegExp matching any supported freshness comment sentinel block.
 */
export function getFreshnessSentinelRegex(): RegExp {
  const startTokens = BRAND_CONFIG.sentinels.freshnessStart.join('|');
  const endTokens = BRAND_CONFIG.sentinels.freshnessEnd.join('|');
  return new RegExp(`<!--\\s*(?:${startTokens})\\s*-->[\\s\\S]*?<!--\\s*(?:${endTokens})\\s*-->`);
}

/**
 * Formats a canonical freshness sentinel comment block.
 */
export function createFreshnessMarker(snapshotSha: string, command: string = `${BRAND_CONFIG.identity.cliName} refresh --check`): string {
  return `<!-- ${BRAND_CONFIG.sentinels.freshnessStart[0]} -->\n> **${BRAND_CONFIG.identity.name} snapshot:** ${BRAND_CONFIG.identity.name}@${snapshotSha}. Verify live state with \`${command}\`.\n<!-- ${BRAND_CONFIG.sentinels.freshnessEnd[0]} -->`;
}

export type StoreKey = keyof typeof BRAND_CONFIG.stores;

/**
 * Resolves the path of a global persistent store file (config, projects, schedules, categories)
 * with transparent fallback to the legacy ~/.nexusflow/<file> if present.
 */
export function resolveUserStorePath(storeKey: StoreKey): string {
  return resolveGlobalDurablePath(BRAND_CONFIG.stores[storeKey]);
}

/**
 * Resolves a lock file inside the global locks directory.
 */
export function resolveResourceLockPath(lockFileName: string): string {
  return path.join(resolveBrandHomeDir(), BRAND_CONFIG.resources.locksDir, lockFileName);
}

