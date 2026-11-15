/**
 * @module core/verify
 * Mechanical verification gate for repositories in a ContextSpace workspace.
 *
 * Runs detected or configured test commands, captures process exit codes,
 * execution duration, stdout/stderr, and anchors validation proof to the Git
 * HEAD commit SHA and working-tree clean status.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';

import type {
  RepoVerificationReport,
  VerificationStatus,
  WorkspaceVerificationReport,
} from '../types.js';
import { loadFeatureConfig, resolveRepoInfos } from './workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { getRepoStatus } from '../utils/multi-git.js';
import { recordVerificationReport } from './workspace-state.js';
import { resolveActiveDomainRules, getDomainPack } from './domain-packs.js';
import { toErrorMessage } from '../utils/errors.js';
import { assertWorkspaceActive } from './archive-guard.js';

export interface VerifyCommandSpec {
  command: string;
  args: string[];
  runner: string;
  followingCommands?: VerifyCommandSpec[];
}

export interface VerifyRepoOptions {
  filter?: string;
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  allowDirty?: boolean;
}

export interface VerifyWorkspaceOptions extends VerifyRepoOptions {
  repoName?: string;
  tag?: string;
}

/**
 * Checks whether a file exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Parse literal arguments and && chains without invoking a shell. */
function parseVerificationCommands(input: string): VerifyCommandSpec[] {
  const commands: VerifyCommandSpec[] = [];
  let args: string[] = [];
  let token = '';
  let started = false;
  let quote: string | undefined;
  const finishToken = () => {
    if (started) args.push(token);
    token = '';
    started = false;
  };
  const finishCommand = () => {
    finishToken();
    if (!args.length || !args[0]) throw new Error('Empty verification command.');
    commands.push({ command: args[0], args: args.slice(1), runner: 'custom' });
    args = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (char === '\\' && quote !== "'" && next &&
      (next === '"' || next === '\\' || (!quote && /[\s'&]/.test(next)))) {
      token += next;
      started = true;
      i++;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      finishToken();
    } else if (char === '&' && next === '&') {
      finishCommand();
      i++;
    } else if (/[|;&<>]/.test(char)) {
      throw new Error('Verification commands support literal arguments and &&; use a script for other shell operators.');
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in verification command.');
  finishCommand();
  return commands;
}

/**
 * Detects the appropriate test command and runner for a repository path.
 */
export async function detectTestCommand(
  repoPath: string,
  preferredCommand?: string,
): Promise<VerifyCommandSpec | null> {
  if (preferredCommand && preferredCommand.trim()) {
    const [first, ...followingCommands] = parseVerificationCommands(preferredCommand.trim());
    return followingCommands.length ? { ...first!, followingCommands } : first!;
  }

  // 1. Node.js / JavaScript / TypeScript
  const pkgPath = path.join(repoPath, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const raw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      if (pkg.scripts && typeof pkg.scripts.test === 'string') {
        if (await fileExists(path.join(repoPath, 'pnpm-lock.yaml'))) {
          return { command: 'pnpm', args: ['test'], runner: 'pnpm' };
        }
        if (await fileExists(path.join(repoPath, 'yarn.lock'))) {
          return { command: 'yarn', args: ['test'], runner: 'yarn' };
        }
        if (
          (await fileExists(path.join(repoPath, 'bun.lockb'))) ||
          (await fileExists(path.join(repoPath, 'bun.lock')))
        ) {
          return { command: 'bun', args: ['test'], runner: 'bun' };
        }
        return { command: 'npm', args: ['test'], runner: 'npm' };
      }
    } catch {
      // Ignore parse failure; continue detection
    }
  }

  // 2. Rust
  if (await fileExists(path.join(repoPath, 'Cargo.toml'))) {
    return { command: 'cargo', args: ['test'], runner: 'cargo' };
  }

  // 3. Go
  if (await fileExists(path.join(repoPath, 'go.mod'))) {
    return { command: 'go', args: ['test', './...'], runner: 'go' };
  }

  // 4. Python
  if (
    (await fileExists(path.join(repoPath, 'pytest.ini'))) ||
    (await fileExists(path.join(repoPath, 'pyproject.toml'))) ||
    (await fileExists(path.join(repoPath, 'setup.cfg'))) ||
    (await fileExists(path.join(repoPath, 'tests')))
  ) {
    return { command: 'pytest', args: [], runner: 'pytest' };
  }

  // 5. Makefile
  const makefilePath = path.join(repoPath, 'Makefile');
  if (await fileExists(makefilePath)) {
    try {
      const makeContent = await fs.readFile(makefilePath, 'utf-8');
      if (/^test\s*:/m.test(makeContent)) {
        return { command: 'make', args: ['test'], runner: 'make' };
      }
    } catch {
      // Ignore
    }
  }

  // 6. Java (Maven / Gradle)
  if (await fileExists(path.join(repoPath, 'pom.xml'))) {
    return { command: 'mvn', args: ['test'], runner: 'maven' };
  }
  if (
    (await fileExists(path.join(repoPath, 'build.gradle'))) ||
    (await fileExists(path.join(repoPath, 'build.gradle.kts')))
  ) {
    const hasWrapper = await fileExists(path.join(repoPath, 'gradlew'));
    return { command: hasWrapper ? './gradlew' : 'gradle', args: ['test'], runner: 'gradle' };
  }

  // 7. .NET / C#
  try {
    const entries = await fs.readdir(repoPath);
    if (entries.some((e) => e.endsWith('.sln') || e.endsWith('.csproj'))) {
      return { command: 'dotnet', args: ['test'], runner: 'dotnet' };
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Builds the arguments list including any test filter.
 */
function buildArgsWithFilter(spec: VerifyCommandSpec, filter?: string): string[] {
  if (!filter || !filter.trim()) return [...spec.args];
  const trimmed = filter.trim();

  switch (spec.runner) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return [...spec.args, '--', trimmed];
    case 'cargo':
      return [...spec.args, '--', trimmed];
    case 'pytest':
      return [...spec.args, '-k', trimmed];
    case 'go':
      return ['test', '-run', trimmed, './...'];
    case 'dotnet':
      return [...spec.args, '--filter', trimmed];
    default:
      return [...spec.args, trimmed];
  }
}

export interface RepositorySnapshot {
  headSha: string;
  clean: boolean;
  dirtyFiles: string[];
  fingerprint: string;
  /**
   * Git tree hash of the working tree as it is (tracked edits plus untracked,
   * non-ignored files). Unlike `fingerprint` it survives committing the same
   * content, so evidence stays fresh when tested changes are committed as-is.
   */
  contentTree: string;
}

/**
 * Hashes the working tree into a Git tree object using a throwaway index, so
 * the user's real index (their staging) is never read or modified.
 */
export async function captureContentTree(repoPath: string): Promise<string> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'contextspace-tree-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    // Seed from a copy of the real index for its stat cache (so unchanged files
    // are not re-hashed); `add -A` then makes it match the working tree exactly.
    const { stdout: indexPath } = await execa('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: repoPath });
    try {
      await fs.copyFile(indexPath.trim(), env.GIT_INDEX_FILE);
    } catch {
      await execa('git', ['read-tree', 'HEAD'], { cwd: repoPath, env });
    }
    await execa('git', ['add', '-A', '--', '.'], { cwd: repoPath, env });
    const { stdout } = await execa('git', ['write-tree'], { cwd: repoPath, env });
    const tree = stdout.trim();
    if (!tree) throw new Error('Cannot hash the working tree.');
    return tree;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Captures the identity of a repository's current content: HEAD, dirty files
 * and a fingerprint over the diff and untracked files. Fails closed.
 */
export async function captureRepositorySnapshot(repoPath: string): Promise<RepositorySnapshot> {
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  const headSha = stdout.trim();
  if (!headSha) throw new Error('Cannot determine the repository HEAD.');
  const status = await getRepoStatus(repoPath);
  // getRepoStatus intentionally returns a fallback for display callers. A gate must fail closed.
  if (status.summary?.startsWith('Error:')) throw new Error(status.summary);
  const { stdout: diff } = await execa('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { cwd: repoPath });
  const hash = createHash('sha256').update(diff).update(JSON.stringify(status.files));
  for (const file of status.files.filter((file) => file.code === '??')) {
    hash.update(file.path).update(await fs.readFile(path.join(repoPath, file.path)));
  }
  const contentTree = await captureContentTree(repoPath);
  return {
    headSha,
    clean: !status.hasChanges,
    dirtyFiles: status.files.map((file) => file.path),
    fingerprint: hash.digest('hex'),
    contentTree,
  };
}

/**
 * Runs mechanical verification for a single repository.
 */
export async function verifyRepo(
  repoPath: string,
  repoName: string,
  options: VerifyRepoOptions = {},
): Promise<RepoVerificationReport> {
  const verifiedAt = new Date().toISOString();
  let headSha = 'unknown';
  let clean: boolean;
  let dirtyFiles: string[] = [];

  let before: RepositorySnapshot | undefined;
  let snapshotError: string | undefined;
  try {
    before = await captureRepositorySnapshot(repoPath);
    ({ headSha, clean, dirtyFiles } = before);
  } catch (error) {
    clean = false;
    snapshotError = `Cannot verify repository state: ${error instanceof Error ? error.message : String(error)}`;
  }

  const spec = await detectTestCommand(repoPath, options.command);
  if (!spec) {
    return {
      repoName,
      repoPath,
      status: 'no-tests',
      command: 'none',
      exitCode: null,
      headSha,
      clean,
      dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
      fingerprint: before?.fingerprint,
      contentTree: before?.contentTree,
      durationMs: 0,
      verifiedAt,
    };
  }

  const commands = [spec, ...(spec.followingCommands ?? [])].map((command) => ({
    ...command, args: buildArgsWithFilter(command, options.filter),
  }));
  const fullCommandStr = commands.map((command) => `${command.command} ${command.args.join(' ')}`.trim()).join(' && ');
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;

  try {
    let result: { exitCode?: number; timedOut?: boolean; stdout?: string; stderr?: string } = {};
    let stdout = '';
    let stderr = '';
    for (const command of commands) {
      const remainingMs = timeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) {
        result = { timedOut: true, exitCode: 124 };
        break;
      }
      result = await execa(command.command, command.args, {
        cwd: repoPath,
        reject: false,
        timeout: remainingMs,
        env: { ...process.env, CI: 'true', ...(options.env ?? {}) },
      });
      stdout = [stdout, result.stdout].filter(Boolean).join('\n').slice(-10000);
      stderr = [stderr, result.stderr].filter(Boolean).join('\n').slice(-10000);
      if (result.timedOut || result.exitCode !== 0) break;
    }

    let proofError = snapshotError;
    try {
      const after = await captureRepositorySnapshot(repoPath);
      clean = after.clean;
      dirtyFiles = after.dirtyFiles;
      if (before && (after.headSha !== before.headSha || after.fingerprint !== before.fingerprint)) {
        proofError = 'Repository changed while tests were running. Review the changes and rerun verification.';
      }
    } catch (error) {
      clean = false;
      proofError = `Cannot confirm repository state after tests: ${error instanceof Error ? error.message : String(error)}`;
    }

    const durationMs = Date.now() - startTime;
    const exitCode = result.exitCode ?? (result.timedOut ? 124 : 1);

    let status: VerificationStatus;
    if (result.timedOut) {
      status = 'timeout';
    } else if (exitCode === 0) {
      status = proofError ? 'fail' : clean ? 'pass' : 'pass_dirty';
    } else {
      status = 'fail';
    }

    return {
      repoName,
      repoPath,
      status,
      command: fullCommandStr,
      exitCode,
      headSha,
      clean,
      dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
      // Only content that stayed identical through the run is proven tested.
      fingerprint: proofError ? undefined : before?.fingerprint,
      contentTree: proofError ? undefined : before?.contentTree,
      durationMs,
      error: proofError,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
      verifiedAt,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      repoName,
      repoPath,
      status: 'fail',
      command: fullCommandStr,
      exitCode: 1,
      headSha,
      clean,
      dirtyFiles: dirtyFiles.length > 0 ? dirtyFiles : undefined,
      durationMs,
      error: toErrorMessage(err),
      verifiedAt,
    };
  }
}

/**
 * Runs mechanical verification for an entire workspace.
 */
export async function verifyWorkspace(
  workspacePath: string,
  options: VerifyWorkspaceOptions = {},
): Promise<WorkspaceVerificationReport> {
  const verifiedAt = new Date().toISOString();
  const startTime = Date.now();

  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) {
    throw new Error(`Workspace configuration not found at ${workspacePath}`);
  }
  assertWorkspaceActive(feature, 'run verification');

  const resolvedPaths = feature.repos.map((r) => resolveFeatureRepoPath(feature, workspacePath, r));
  const repoInfos = await resolveRepoInfos(resolvedPaths);

  const targets = options.repoName
    ? repoInfos.filter((r) => r.name === options.repoName)
    : repoInfos;

  if (options.repoName && targets.length === 0) {
    throw new Error(`Repository "${options.repoName}" not found in workspace.`);
  }

  const domainRules = resolveActiveDomainRules(feature.organizationId, feature.domainPacks ?? []);
  let domainVerifyCmd: string | undefined = undefined;
  if (options.tag) {
    const pack = getDomainPack(options.tag);
    if (!pack) {
      throw new Error(`Category / tag pack "${options.tag}" not found.`);
    }
    domainVerifyCmd = pack.verifyCommand;
  } else if (domainRules.compositeVerifyCommand) {
    domainVerifyCmd = domainRules.compositeVerifyCommand;
  }

  const repoReports: RepoVerificationReport[] = [];
  for (const target of targets) {
    const customCommand =
      options.command ?? domainVerifyCmd ?? feature.resumption?.verifyCommand ?? feature.resumption?.testCommand;
    const report = await verifyRepo(target.path, target.name, {
      ...options,
      command: customCommand,
    });
    repoReports.push(report);
  }

  let overallStatus: VerificationStatus = 'pass';
  if (repoReports.some((r) => r.status === 'fail')) {
    overallStatus = 'fail';
  } else if (repoReports.some((r) => r.status === 'timeout')) {
    overallStatus = 'timeout';
  } else if (repoReports.some((r) => r.status === 'pass_dirty')) {
    overallStatus = 'pass_dirty';
  } else if (repoReports.every((r) => r.status === 'no-tests')) {
    overallStatus = 'no-tests';
  }

  const canProgress =
    overallStatus === 'pass' ||
    overallStatus === 'no-tests' ||
    (overallStatus === 'pass_dirty' && options.allowDirty === true);

  const totalDurationMs = Date.now() - startTime;
  const workspaceReport: WorkspaceVerificationReport = {
    workspacePath,
    overallStatus,
    canProgress,
    verifiedAt,
    durationMs: totalDurationMs,
    repos: repoReports,
  };

  // Record verification proof in workspace state
  await recordVerificationReport(workspacePath, workspaceReport);

  return workspaceReport;
}
