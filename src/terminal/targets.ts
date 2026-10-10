import * as fs from 'node:fs';
import * as path from 'node:path';
import { findExecutable, getAugmentedPath } from '../utils/user-paths.js';
import { CLI_HARNESSES, harnessPromptArgs, isCliHarnessId, type CliHarnessId } from '../utils/cli-harnesses.js';

export type TerminalTarget = 'shell' | CliHarnessId;
export interface LaunchSpec { file: string; args: string[]; env: NodeJS.ProcessEnv; label: string }

export function terminalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: getAugmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // Desktop launches its backend as Electron-as-Node. Do not propagate that
  // runtime mode or injected Node options into users' shells and harnesses.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (process.platform === 'win32') env.Path = env.PATH;
  return env;
}

/** Prefer the CLI generated for this workspace over an older global install. */
export function withWorkspaceCli(launch: LaunchSpec, workspaceRoot: string): LaunchSpec {
  const bin = path.join(workspaceRoot, '.contextspace', 'bin');
  const executable = path.join(bin, process.platform === 'win32' ? 'ctxspace.cmd' : 'ctxspace');
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    return launch;
  }
  const current = launch.env.PATH ?? launch.env.Path ?? '';
  const env: NodeJS.ProcessEnv = { ...launch.env, PATH: `${bin}${path.delimiter}${current}` };
  if (process.platform === 'win32') env.Path = env.PATH;
  return { ...launch, env };
}

export function resolveShell(env = terminalEnvironment(), platform = process.platform): string {
  if (platform === 'win32') {
    const shell = findExecutable('pwsh.exe', env, platform) ?? findExecutable('powershell.exe', env, platform);
    if (!shell) throw new Error('PowerShell was not found. Install PowerShell or check your PATH.');
    return shell;
  }
  const candidates = [env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const shell of candidates) {
    if (!shell || !path.isAbsolute(shell)) continue;
    try { fs.accessSync(shell, fs.constants.X_OK); if (fs.statSync(shell).isFile()) return shell; } catch { /* next shell */ }
  }
  throw new Error('No interactive shell was found.');
}

/**
 * How to start a target. `prompt` is a first message for a new session (not a resumed one): the tool
 * starts with it as its first turn. A tool that cannot take one starts without it.
 */
export function resolveLaunch(target: string, sessionId?: string, baseEnv = terminalEnvironment(), platform = process.platform, prompt?: string): LaunchSpec {
  // An AI tool learns it is one, so `ctxspace plan` acts as the AI and names the tool; a shell is a person.
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.CTXSPACE_HARNESS;
  if (target === 'shell') {
    if (sessionId) throw new Error('Shells do not have saved assistant sessions.');
    const file = resolveShell(env, platform);
    return { file, args: platform === 'win32' ? ['-NoLogo'] : ['-l'], env, label: path.basename(file) };
  }
  if (!isCliHarnessId(target)) throw new Error('This harness does not have an embedded terminal target.');
  env.CTXSPACE_HARNESS = target;
  const harness = CLI_HARNESSES[target];
  let file: string | null | undefined;
  for (const binary of ('terminalBinaries' in harness ? harness.terminalBinaries : [harness.binary])) {
    file = findExecutable(binary, env, platform);
    if (file) break;
  }
  if (!file) throw new Error(`${harness.name} is not installed or is not on PATH. Install it, then refresh the terminal list.`);
  let args: string[] = [];
  if (sessionId) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid saved session ID.');
    args = harness.resumeArgs(sessionId);
  } else if (prompt) {
    args = harnessPromptArgs(target, prompt) ?? [];
  }
  if (platform === 'win32' && !/\.exe$/i.test(file)) {
    // npm shims cannot be passed directly to CreateProcess. PowerShell's call
    // operator receives server-resolved, single-quoted literals, never raw input.
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const command = `& ${[file, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
    return { file: resolveShell(env, platform), args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], env, label: harness.name };
  }
  return { file, args, env, label: harness.name };
}

export function listTerminalTargets() {
  return ['shell', ...Object.keys(CLI_HARNESSES)].map(id => {
    try { const spec = resolveLaunch(id); return { id, name: spec.label, available: true, reason: null }; }
    catch (error) { return { id, name: id === 'shell' ? 'Shell' : CLI_HARNESSES[id as CliHarnessId].name, available: false, reason: (error as Error).message }; }
  });
}
