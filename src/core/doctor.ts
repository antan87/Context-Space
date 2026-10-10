/**
 * @module core/doctor
 * Headless workspace diagnostics. Produces a structured {@link DoctorReport}
 * shared by the CLI `doctor` renderer and the MCP `run_doctor` tool.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execa } from 'execa';
import { globby } from 'globby';

import { loadFeatureConfig, resolveRepoInfos } from './workspace.js';
import { isInPlace, resolveFeatureRepoPath } from '../utils/feature.js';
import { getConventionalTestCommands } from '../utils/test-command.js';
import { getRepoStatus } from '../utils/multi-git.js';
import { workspaceFileExists } from './storage.js';
import { analyzeAllReposCached } from '../analyzers/index.js';
import { findExecutable } from '../agent/cliAvailability.js';
import { checkGenerationLock } from './generation-lock.js';
import { readWorkspaceKnowledge } from './knowledge.js';
import { inspectAgentMcp } from './agent-mcp.js';
import { describeWorkspaceBackup } from './workspace-backup.js';
import { CLI_NAME } from './constants.js';

import type { ProjectAnalysis } from '../types.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** A single diagnostic result. */
export interface DoctorCheck {
  category: string;
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

/** Full diagnostic report for a workspace. */
export interface DoctorReport {
  workspacePath: string;
  branchName: string;
  checks: DoctorCheck[];
  errors: string[];
  warnings: string[];
  healthy: boolean;
  /** True when worktree-path errors aborted the deeper checks. */
  aborted: boolean;
}


/**
 * Runs all workspace diagnostics and returns a structured report.
 *
 * @param workspacePath - Absolute path to the workspace directory.
 * @throws If the workspace manifest cannot be loaded.
 */
export async function runDoctor(workspacePath: string): Promise<DoctorReport> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    throw new Error('Failed to load workspace configuration. Ensure nexusflow.json exists.');
  }

  const resolvedPaths = feature.repos.map((r) => resolveFeatureRepoPath(feature, workspacePath, r));
  const allRepos = await resolveRepoInfos(resolvedPaths);
  const checks: DoctorCheck[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const report = (): DoctorReport => ({
    workspacePath,
    branchName: feature.branchName,
    checks,
    errors,
    warnings,
    healthy: errors.length === 0 && warnings.length === 0,
    aborted: false,
  });

  // ── 1. Worktree Paths ──────────────────────────────────────────────────
  let worktreeErrors = false;
  for (const repo of allRepos) {
    try {
      const stat = await fs.stat(repo.path);
      if (!stat.isDirectory()) {
        errors.push(`Worktree path for "${repo.name}" is not a directory.`);
        checks.push({ category: 'Worktree Paths', name: repo.name, status: 'fail', message: 'Path is not a directory' });
        worktreeErrors = true;
      } else {
        checks.push({ category: 'Worktree Paths', name: repo.name, status: 'pass', message: 'Directory exists' });
      }
    } catch {
      errors.push(`Worktree path for "${repo.name}" does not exist: ${repo.path}`);
      checks.push({ category: 'Worktree Paths', name: repo.name, status: 'fail', message: 'Path does not exist' });
      worktreeErrors = true;
    }
  }

  if (worktreeErrors) {
    return { ...report(), aborted: true };
  }

  // ── 2. Analysis (feeds later checks) ───────────────────────────────────
  const { analysis } = await analyzeAllReposCached(allRepos, workspacePath);

  // Explicit runtime seams complement the package graph. Validate them here so
  // a typo cannot leave a contract pointing at nonexistent evidence.
  if (feature.contracts?.length) {
    const knowledge = await readWorkspaceKnowledge(workspacePath) ?? '';
    const endpointExists = async (value: string): Promise<boolean> => {
      if (allRepos.some((repo) => repo.name === value || repo.path === value || path.basename(repo.path) === value)) {
        return true;
      }
      for (const repo of allRepos) {
        try {
          const candidate = path.resolve(repo.path, value);
          const relative = path.relative(repo.path, candidate);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          await fs.access(candidate);
          return true;
        } catch {
          // Try the next repository root.
        }
      }
      return false;
    };
    for (const contract of feature.contracts) {
      const values = [contract.from, contract.to];
      const invalidPath = values.some((value) => !value || value.includes('..') || path.isAbsolute(value));
      const validEntry = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contract.entry);
      const heading = contract.entry.replace(/^(\d{4}-\d{2}-\d{2})-/, '$1 — ');
      if (invalidPath || !contract.kind || !validEntry) {
        const message = `Invalid explicit contract ${contract.from || '?'} -> ${contract.to || '?'}.`;
        errors.push(message);
        checks.push({ category: 'Explicit Contracts', name: contract.kind || 'contract', status: 'fail', message });
      } else if (!(await endpointExists(contract.from)) || !(await endpointExists(contract.to))) {
        const message = `Contract ${contract.from} -> ${contract.to} references a repository or path that does not exist.`;
        errors.push(message);
        checks.push({ category: 'Explicit Contracts', name: contract.kind, status: 'fail', message });
      } else if (!knowledge.includes(`### ${heading}`)) {
        const message = `Contract ${contract.from} -> ${contract.to} references missing knowledge entry ${contract.entry}.`;
        warnings.push(message);
        checks.push({ category: 'Explicit Contracts', name: contract.kind, status: 'warn', message });
      } else {
        checks.push({ category: 'Explicit Contracts', name: contract.kind, status: 'pass', message: `${contract.from} -> ${contract.to} is backed by ${contract.entry}` });
      }
    }
  }

  // ── 3. Branch Alignment & Git Status ───────────────────────────────────
  for (const repo of allRepos) {
    let branch = 'unknown';
    try {
      const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.path });
      branch = stdout.trim();
    } catch {
      // Detached HEAD or git failure — leave as 'unknown'.
    }

    if (isInPlace(feature)) {
      const isolated = feature.isolatedRepos?.[repo.name] ?? feature.isolatedRepos?.[repo.path];
      if (isolated) {
        const expectedBranch = isolated.branchName;
        if (branch !== expectedBranch) {
          warnings.push(`Repository "${repo.name}" is checked out on branch "${branch}", but isolated worktree branch is "${expectedBranch}".`);
          checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'warn', message: `Branch mismatch (${branch} vs expected ${expectedBranch} [isolated worktree])` });
        } else {
          checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'pass', message: `Aligned on branch "${branch}" (isolated worktree)` });
        }
      } else {
        // In-place workspaces have no expected branch — the user manages
        // branches; a mismatch warning here would fire for every repo forever.
        checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'info', message: `On branch "${branch}" (in-place workspace — branches managed by you)` });
      }
    } else {
      // Per-repo existing-branch overrides are expected to differ from the
      // feature branch.
      const expectedBranch = feature.repoBranches?.[repo.name] ?? feature.branchName;
      if (branch !== expectedBranch) {
        warnings.push(`Repository "${repo.name}" is checked out on branch "${branch}", but workspace branch is "${expectedBranch}".`);
        checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'warn', message: `Branch mismatch (${branch} vs expected ${expectedBranch})` });
      } else {
        checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'pass', message: `Aligned on branch "${branch}"` });
      }
    }

    const status = await getRepoStatus(repo.path);
    if (status.hasChanges) {
      warnings.push(`Repository "${repo.name}" has uncommitted changes.`);
      checks.push({ category: 'Branch Alignment & Git Status', name: repo.name, status: 'warn', message: `Has uncommitted changes (${status.summary})` });
    }
  }

  // ── 4. Local Package Setup & Reference Versioning ──────────────────────
  let hasCsharp = false;
  let hasNode = false;

  for (const repo of allRepos) {
    const a = analysis.get(repo.path);
    if (!a) continue;

    if (a.techStack.languages.includes('csharp')) hasCsharp = true;
    if (a.techStack.languages.includes('typescript') || a.techStack.languages.includes('javascript')) hasNode = true;

    if (a.techStack.languages.includes('csharp')) {
      try {
        const csprojs = await globby('**/*.csproj', {
          cwd: repo.path,
          absolute: true,
          ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/dist/**', '**/out/**', '**/.git/**'],
        });
        for (const csproj of csprojs) {
          const content = await fs.readFile(csproj, 'utf-8');
          if (content.toLowerCase().includes('-local') || content.toLowerCase().includes('-dev')) {
            warnings.push(`Temporary package version (e.g. ending in "-local" or "-dev") found in "${path.basename(csproj)}".`);
            checks.push({ category: 'Local Package Setup', name: repo.name, status: 'warn', message: `Temporary local package version in "${path.basename(csproj)}"` });
          }
        }
      } catch {}

      if (a.nugetFeeds && a.nugetFeeds.length === 0) {
        try {
          const nugetConfigs = await globby('**/NuGet.config', {
            cwd: repo.path,
            ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/dist/**', '**/out/**', '**/.git/**'],
          });
          if (nugetConfigs.length === 0) {
            warnings.push(`Repository "${repo.name}" does not have a NuGet.config. It might not resolve local package dependencies.`);
            checks.push({ category: 'Local Package Setup', name: repo.name, status: 'warn', message: 'No NuGet.config found (needed for local package feeds)' });
          }
        } catch {}
      }
    }

    if (a.techStack.languages.includes('typescript') || a.techStack.languages.includes('javascript')) {
      try {
        const pjs = await globby('**/package.json', {
          cwd: repo.path,
          absolute: true,
          ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/dist/**', '**/out/**', '**/.git/**'],
        });
        for (const pj of pjs) {
          const content = await fs.readFile(pj, 'utf-8');
          if (content.includes('"file:') || content.includes('"link:')) {
            warnings.push(`Temporary package link/file reference (e.g., "file:../") found in "${path.basename(pj)}".`);
            checks.push({ category: 'Local Package Setup', name: repo.name, status: 'warn', message: `Temporary local dependency reference ("file:" or "link:") in "${path.basename(pj)}"` });
          }
        }
      } catch {}
    }
  }

  if (hasCsharp || hasNode) {
    checks.push({ category: 'Local Package Setup', name: 'validation', status: 'pass', message: 'Local registry feeds/link validation completed.' });
  } else {
    checks.push({ category: 'Local Package Setup', name: 'validation', status: 'info', message: 'No C# or Node.js repositories to validate.' });
  }

  // ── 5. Test Commands ───────────────────────────────────────────────────
  for (const repo of allRepos) {
    const a = analysis.get(repo.path);
    if (!a) continue;

    const testCommands = getConventionalTestCommands(a);
    const hasTypeScriptOrJs = Boolean(
      a.techStack?.languages?.includes('typescript') || a.techStack?.languages?.includes('javascript'),
    );
    const isFallback = testCommands.length === 1 &&
      testCommands[0] === 'npm test' &&
      !hasTypeScriptOrJs;

    if (isFallback) {
      warnings.push(`Repository "${repo.name}" fell back to default test command "npm test".`);
      checks.push({ category: 'Test Commands', name: repo.name, status: 'warn', message: 'Using default fallback test command "npm test"' });
    } else {
      const commandStr = testCommands.map((c) => `"${c}"`).join(', ');
      checks.push({
        category: 'Test Commands',
        name: repo.name,
        status: 'pass',
        message: testCommands.length > 1 ? `Test commands are ${commandStr}` : `Test command is ${commandStr}`,
      });
    }
  }

  // ── 6. Core Artifacts ──────────────────────────────────────────────────
  const featureId = path.basename(workspacePath);
  const coreFiles: Array<{ name: string; exists: () => Promise<boolean> }> = [
    // AGENTS.md first: it is the canonical file assistants load (which Claude
    // Code supports as fallback or via CLAUDE.md's `@AGENTS.md` import). Without
    // it a workspace has no context at all, and an import in CLAUDE.md fails
    // silently — so a doctor run that did not check it reported a clean bill of
    // health on a workspace that could tell an assistant nothing.
    { name: 'AGENTS.md', exists: () => workspaceFileExists(workspacePath, featureId, 'AGENTS.md') },
    { name: 'WORKSPACE.md', exists: () => workspaceFileExists(workspacePath, featureId, 'WORKSPACE.md') },
    { name: 'contextspace-knowledge.md', exists: () => workspaceFileExists(workspacePath, featureId, 'contextspace-knowledge.md') },
    { name: 'contextspace-plan.md', exists: () => workspaceFileExists(workspacePath, featureId, 'contextspace-plan.md') },
    {
      name: 'contextspace.lock',
      exists: async () => {
        const primary = path.join(workspacePath, 'contextspace.lock');
        const legacy = path.join(workspacePath, 'nexusflow.lock');
        return (await fs.access(primary).then(() => true).catch(() => false))
          || (await fs.access(legacy).then(() => true).catch(() => false));
      },
    },
  ];
  // Per-repo architecture maps are no longer generated — everything they held
  // came from the repo's package.json — so their absence is not a fault.

  for (const file of coreFiles) {
    if (await file.exists()) {
      checks.push({ category: 'Core Artifacts', name: file.name, status: 'pass', message: 'exists' });
    } else {
      warnings.push(`Missing core workspace artifact: "${file.name}".`);
      checks.push({ category: 'Core Artifacts', name: file.name, status: 'warn', message: 'is missing' });
    }
  }

  const generation = await checkGenerationLock(workspacePath, { markDocuments: true });
  if (generation.fresh) {
    checks.push({ category: 'Generated Context', name: 'provenance', status: 'pass', message: 'repo snapshot and generated-view hashes match nexusflow.lock' });
  } else {
    for (const item of generation.drift) {
      warnings.push(item.message);
      checks.push({ category: 'Generated Context', name: item.name, status: 'warn', message: item.message });
    }
  }

  // ── 6b. Would the hand-written notes survive losing this computer? ───────
  // Advisory only: nothing here adds a remote or pushes. It warns just when there is
  // something a person wrote (knowledge, planning notes) that exists nowhere else.
  try {
    const backup = await describeWorkspaceBackup(workspacePath);
    const category = 'Workspace Backup';
    if (backup.remote.state === 'configured') {
      checks.push({ category, name: 'remote', status: 'pass', message: `git remote "${backup.remote.name}" is set (${backup.remote.url || 'no URL'})` });
    } else if (backup.atRisk && backup.message) {
      warnings.push(backup.message);
      checks.push({ category, name: 'remote', status: 'warn', message: backup.message });
    } else {
      checks.push({ category, name: 'remote', status: 'info', message: 'no git remote, but nothing hand-written needs backing up yet' });
    }
  } catch {
    // A diagnostic about backup must never break the workspace report.
  }

  const workspaceName = path.basename(workspacePath);
  const codeWorkspacePath = path.join(workspacePath, `${workspaceName}.code-workspace`);
  try {
    await fs.access(codeWorkspacePath);
    checks.push({ category: 'Core Artifacts', name: `${workspaceName}.code-workspace`, status: 'pass', message: 'exists' });
  } catch {
    warnings.push(`Missing ${workspaceName}.code-workspace. VS Code SCM will not show changes inside repo sub-folders. Run \`nexusflow refresh\` to regenerate it.`);
    checks.push({ category: 'Core Artifacts', name: `${workspaceName}.code-workspace`, status: 'warn', message: 'is missing' });
  }

  const vscodeSettingsPath = path.join(workspacePath, '.vscode', 'settings.json');
  try {
    const content = await fs.readFile(vscodeSettingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed['search.useIgnoreFiles'] === false) {
      checks.push({ category: 'Core Artifacts', name: '.vscode/settings.json', status: 'pass', message: 'configured correctly (search.useIgnoreFiles: false)' });
    } else {
      warnings.push('.vscode/settings.json search.useIgnoreFiles is not set to false. VS Code global search may ignore repository files.');
      checks.push({ category: 'Core Artifacts', name: '.vscode/settings.json', status: 'warn', message: 'search.useIgnoreFiles is not set to false' });
    }
  } catch {
    warnings.push('Missing .vscode/settings.json. VS Code search might not work properly inside sub-repos.');
    checks.push({ category: 'Core Artifacts', name: '.vscode/settings.json', status: 'warn', message: 'is missing or invalid' });
  }

  // ── 7. AI Assistant CLIs ────────────────────────────────────────────────
  const astMap: Record<string, string> = {
    claude: 'claude',
    codex: 'codex',
    antigravity: 'agy',
    copilot: 'copilot',
    cursor: 'cursor-agent',
  };

  if (feature.assistants && feature.assistants.length > 0) {
    for (const a of feature.assistants) {
      const bin = astMap[a.toLowerCase()] ?? a.toLowerCase();
      const resolved = findExecutable(bin);
      if (!resolved) {
        warnings.push(`Workspace assistant "${a}" (${bin}) is not on system PATH.`);
        checks.push({ category: 'AI Assistants', name: a, status: 'warn', message: `CLI binary "${bin}" is not on PATH` });
      } else {
        checks.push({ category: 'AI Assistants', name: a, status: 'pass', message: `binary "${bin}" is available` });
      }
    }
  }

  // ── 7b. MCP server availability for the user's AI agents ────────────────
  // Informational on purpose: the server is optional, so a missing registration
  // must not make an otherwise healthy workspace report warnings.
  try {
    for (const agent of await inspectAgentMcp()) {
      const category = 'AI Agent MCP';
      switch (agent.status.state) {
        case 'registered':
          checks.push({ category, name: agent.name, status: 'pass', message: `MCP server available as "${agent.status.serverName}"` });
          break;
        case 'missing':
          checks.push({ category, name: agent.name, status: 'info', message: `has no user-level MCP registration, so it only gets the server where a workspace config provides one (for example, it cannot call request_user_input elsewhere). Run \`${CLI_NAME} mcp setup\`` });
          break;
        case 'unsupported':
          checks.push({ category, name: agent.name, status: 'info', message: agent.status.reason });
          break;
        case 'unreadable':
          checks.push({ category, name: agent.name, status: 'info', message: `could not read its MCP config (${agent.status.reason})` });
          break;
        case 'not-installed':
          break;
      }
    }
  } catch {
    // Diagnostics about the user's agents must never break the workspace report.
  }

  // ── 8. System & OS Environment ──────────────────────────────────────────
  const gitBin = findExecutable('git');
  if (gitBin) {
    try {
      const gitVersionRes = await execa(gitBin, ['--version'], { reject: false });
      const versionMatch = gitVersionRes.stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
      if (versionMatch) {
        const major = parseInt(versionMatch[1]!, 10);
        const minor = parseInt(versionMatch[2]!, 10);
        if (major < 2 || (major === 2 && minor < 20)) {
          warnings.push(`git version ${versionMatch[0]} is older than recommended (>= 2.20 recommended for worktree operations).`);
          checks.push({ category: 'Environment', name: 'git', status: 'warn', message: `version ${versionMatch[0]} (>= 2.20 recommended)` });
        } else {
          checks.push({ category: 'Environment', name: 'git', status: 'pass', message: `version ${versionMatch[0]} (>= 2.20)` });
        }
      } else {
        warnings.push('git is installed but its version could not be determined.');
        checks.push({ category: 'Environment', name: 'git', status: 'warn', message: 'installed on PATH (could not determine version)' });
      }
    } catch {
      warnings.push('git is installed but its version check failed.');
      checks.push({ category: 'Environment', name: 'git', status: 'warn', message: 'installed on PATH (version check failed)' });
    }
  } else {
    errors.push('git is not found on PATH. Git is required for workspace operations.');
    checks.push({ category: 'Environment', name: 'git', status: 'fail', message: 'git is not on PATH' });
  }

  if (process.platform === 'linux') {
    const xdgOpen = findExecutable('xdg-open');
    if (xdgOpen) {
      checks.push({ category: 'Environment', name: 'xdg-utils', status: 'pass', message: 'xdg-open is available for desktop integration' });
    } else {
      warnings.push('xdg-open is not installed. Installing xdg-utils is recommended for opening browsers and editors on Linux.');
      checks.push({ category: 'Environment', name: 'xdg-utils', status: 'warn', message: 'xdg-open not found (install xdg-utils)' });
    }
  }

  return report();
}
