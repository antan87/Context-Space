/**
 * @module core/constants
 * Centralized constants and resolution helpers for ContextSpace brand naming,
 * file names, legacy compatibility fallbacks, and environment variables.
 *
 * All constants are strongly typed and derived directly from BRAND_CONFIG.
 */

import { BRAND_CONFIG } from './brand-config.js';

export * from './brand-config.js';

export const BRAND_NAME = BRAND_CONFIG.identity.name;
export const BRAND_TAGLINE = BRAND_CONFIG.identity.tagline;
export const LEGACY_BRAND_NAME = BRAND_CONFIG.identity.legacyName;
export const CLI_NAME = BRAND_CONFIG.identity.cliName;
export const CLI_ALIASES = BRAND_CONFIG.identity.cliAliases;
export const MCP_SERVER_NAME = BRAND_CONFIG.mcp.serverName;
export const LEGACY_MCP_SERVER_NAME = BRAND_CONFIG.mcp.legacyServerName;
export const MCP_ADAPTER_SERVER_NAME = BRAND_CONFIG.mcp.adapterServerName;
export const LEGACY_MCP_ADAPTER_SERVER_NAME = BRAND_CONFIG.mcp.legacyAdapterServerName;

// Workspace Manifests
export const PRIMARY_MANIFEST_FILE = BRAND_CONFIG.files.manifest.primary;
export const LEGACY_MANIFEST_FILE = BRAND_CONFIG.files.manifest.legacy;

// Integrity Lockfiles
export const PRIMARY_LOCK_FILE = BRAND_CONFIG.files.lock.primary;
export const LEGACY_LOCK_FILE = BRAND_CONFIG.files.lock.legacy;

// Durable Workspace Memory & Generated Views
export const PRIMARY_KNOWLEDGE_FILE = BRAND_CONFIG.files.knowledge.primary;
export const LEGACY_KNOWLEDGE_FILE = BRAND_CONFIG.files.knowledge.legacy;

export const PRIMARY_PLAN_FILE = BRAND_CONFIG.files.plan.primary;
export const LEGACY_PLAN_FILE = BRAND_CONFIG.files.plan.legacy;

export const PRIMARY_OVERVIEW_FILE = BRAND_CONFIG.files.overview.primary;
export const LEGACY_OVERVIEW_FILE = BRAND_CONFIG.files.overview.legacy;

export const PRIMARY_HANDOFF_FILE = BRAND_CONFIG.files.handoff.primary;
export const LEGACY_HANDOFF_FILE = BRAND_CONFIG.files.handoff.legacy;

// IDE Rules
export const PRIMARY_CURSOR_RULE_FILE = BRAND_CONFIG.files.cursorRule.primary;
export const LEGACY_CURSOR_RULE_FILE = BRAND_CONFIG.files.cursorRule.legacy;

// User Config Directory
export const PRIMARY_CONFIG_DIR_NAME = BRAND_CONFIG.files.configDir.primary;
export const LEGACY_CONFIG_DIR_NAME = BRAND_CONFIG.files.configDir.legacy;

// Collaboration Chat Ledger
export const PRIMARY_CHAT_LEDGER_FILE = BRAND_CONFIG.files.chatLedger.primary;
export const LEGACY_CHAT_LEDGER_FILE = BRAND_CONFIG.files.chatLedger.legacy;

// Internal Workspace State
export const PRIMARY_STATE_FILE = BRAND_CONFIG.files.state.primary;
export const LEGACY_STATE_FILE = BRAND_CONFIG.files.state.legacy;

export const PRIMARY_ANALYSIS_CACHE_FILE = BRAND_CONFIG.files.analysisCache.primary;
export const LEGACY_ANALYSIS_CACHE_FILE = BRAND_CONFIG.files.analysisCache.legacy;

export const PRIMARY_LOGS_DIR = BRAND_CONFIG.files.logsDir.primary;
export const LEGACY_LOGS_DIR = BRAND_CONFIG.files.logsDir.legacy;

// Resource Catalog & Ownership
export const RESOURCE_SKILLS_DIR = BRAND_CONFIG.resources.skillsDir;
export const RESOURCE_AGENTS_DIR = BRAND_CONFIG.resources.agentsDir;
export const RESOURCE_LOCKS_DIR = BRAND_CONFIG.resources.locksDir;
export const RESOURCE_CATALOG_LOCK_FILE = BRAND_CONFIG.resources.catalogLockFile;
export const RESOURCE_ADMIN_LOCK_FILE = BRAND_CONFIG.resources.adminLockFile;
export const RESOURCE_OWNERSHIP_NAME = BRAND_CONFIG.resources.managedOwnershipName;
export const LEGACY_RESOURCE_OWNERSHIP_NAME = BRAND_CONFIG.resources.legacyOwnershipName;
export const RESOURCE_METADATA_KEY = BRAND_CONFIG.resources.metadataKey;
export const LEGACY_RESOURCE_METADATA_KEY = BRAND_CONFIG.resources.legacyMetadataKey;

// GitHub Repository & Releases
export const GITHUB_OWNER = BRAND_CONFIG.github.owner;
export const GITHUB_REPO = BRAND_CONFIG.github.repo;
export const LEGACY_GITHUB_REPO = BRAND_CONFIG.github.legacyRepo;
export const GITHUB_REPO_URL = BRAND_CONFIG.github.repoUrl;
export const LEGACY_GITHUB_REPO_URL = BRAND_CONFIG.github.legacyRepoUrl;
export const GITHUB_RELEASE_API_URL = BRAND_CONFIG.github.releaseApiUrl;
export const LEGACY_GITHUB_RELEASE_API_URL = BRAND_CONFIG.github.legacyReleaseApiUrl;
export const GITHUB_RELEASE_PAGE_URL = BRAND_CONFIG.github.releasePageUrl;
export const LEGACY_GITHUB_RELEASE_PAGE_URL = BRAND_CONFIG.github.legacyReleasePageUrl;
export const GITHUB_USER_AGENT = BRAND_CONFIG.github.userAgent;
export const LEGACY_GITHUB_USER_AGENT = BRAND_CONFIG.github.legacyUserAgent;
export const DESKTOP_INSTALLER_USER_AGENT = BRAND_CONFIG.github.desktopInstallerUserAgent;

// Engine & CLI
export const ENGINE_NAME = BRAND_CONFIG.engine.name;
export const ENGINE_ID = BRAND_CONFIG.engine.id;
export const LEGACY_ENGINE_ID = BRAND_CONFIG.engine.legacyId;
export const ENGINE_COMMAND = BRAND_CONFIG.engine.command;
export const LEGACY_ENGINE_COMMAND = BRAND_CONFIG.engine.legacyCommand;
export const ENGINE_NPM_PACKAGE = BRAND_CONFIG.engine.npmPackage;
export const LEGACY_ENGINE_NPM_PACKAGE = BRAND_CONFIG.engine.legacyNpmPackage;

// Terminal
export const TERMINAL_TITLE_PREFIX = BRAND_CONFIG.terminal.titlePrefix;
export const LEGACY_TERMINAL_TITLE_PREFIX = BRAND_CONFIG.terminal.legacyTitlePrefix;
export const TERMINAL_DEFAULT_TITLE = BRAND_CONFIG.terminal.defaultTitle;
export const TERMINAL_RUNNER_TITLE = BRAND_CONFIG.terminal.runnerTitle;
export const LEGACY_TERMINAL_RUNNER_TITLE = BRAND_CONFIG.terminal.legacyRunnerTitle;

// Workroom Tokens, Headers, and Invitations
export const WORKROOM_BOOTSTRAP_HEADERS = BRAND_CONFIG.workrooms.bootstrapHeaders;
export const WORKROOM_BOOTSTRAP_COOKIES = BRAND_CONFIG.workrooms.bootstrapCookies;
export const WORKROOM_BOOTSTRAP_HEADER = BRAND_CONFIG.workrooms.defaultBootstrapHeader;
export const WORKROOM_BOOTSTRAP_COOKIE = BRAND_CONFIG.workrooms.defaultBootstrapCookie;
export const WORKROOM_INVITE_PROTOCOLS = BRAND_CONFIG.workrooms.inviteProtocols;
export const WORKROOM_DEFAULT_INVITE_PROTOCOL = BRAND_CONFIG.workrooms.defaultInviteProtocol;
export const WORKROOM_EXPORT_EXTENSION = BRAND_CONFIG.workrooms.roomExportExtension;
export const WORKROOM_LEGACY_EXPORT_EXTENSION = BRAND_CONFIG.workrooms.legacyRoomExportExtension;

// Workflows & Built-in Resource Directories
export const RESOURCE_WORKFLOWS_DIR = BRAND_CONFIG.resources.workflowsDir;
export const PACKAGE_LOOP_SKILL_ID = BRAND_CONFIG.resources.packageLoopSkillId;
export const LEGACY_PACKAGE_LOOP_SKILL_ID = BRAND_CONFIG.resources.legacyPackageLoopSkillId;
export const RELEASE_ORDERING_SKILL_ID = BRAND_CONFIG.resources.releaseOrderingSkillId;
export const LEGACY_RELEASE_ORDERING_SKILL_ID = BRAND_CONFIG.resources.legacyReleaseOrderingSkillId;

// Global Persistent Stores
export const STORE_CONFIG_FILE = BRAND_CONFIG.stores.config;
export const STORE_PROJECTS_FILE = BRAND_CONFIG.stores.projects;
export const STORE_SCHEDULES_FILE = BRAND_CONFIG.stores.schedules;
export const STORE_CATEGORIES_FILE = BRAND_CONFIG.stores.categories;

