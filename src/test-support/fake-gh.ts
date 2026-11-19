/**
 * @module test-support/fake-gh
 * A fake `gh` for tests that run on Linux, macOS and Windows. Tests only; not built (see tsconfig `exclude`).
 *
 * The product starts `gh` with execa and no shell. On POSIX a script with a shebang is enough. On Windows a bare script
 * cannot run, but execa (through cross-spawn) does start a `gh.cmd` found on PATH, so a Windows fake is a `gh.cmd`.
 * Two kinds of fake work on both: static pull-request JSON ({@link writeGhJson}) and a Node script
 * ({@link writeGhNode}). A fake written in bash cannot run on Windows, so none is used.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const isWindows = process.platform === 'win32';

/** `PATH` with `dir` first. The separator is `;` on Windows and `:` elsewhere. */
export const pathWith = (dir: string, rest: string): string => `${dir}${path.delimiter}${rest}`;

/** A `gh` that answers `--version` and `auth` and prints `json` for `pr ...`; anything else exits 1. */
export async function writeGhJson(bin: string, json: string): Promise<void> {
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'gh-prs.json'), json);
  if (isWindows) {
    await fs.writeFile(
      path.join(bin, 'gh.cmd'),
      ['@echo off', 'if "%~1"=="--version" (echo gh version 2.40.0& exit /b 0)', 'if "%~1"=="auth" exit /b 0', 'if "%~1"=="pr" (type "%~dp0gh-prs.json"& exit /b 0)', 'exit /b 1', ''].join('\r\n'),
    );
    return;
  }
  await fs.writeFile(
    path.join(bin, 'gh'),
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "gh version 2.40.0"; exit 0; fi\nif [ "$1" = "auth" ]; then exit 0; fi\nif [ "$1" = "pr" ]; then cat "$(dirname "$0")/gh-prs.json"; exit 0; fi\nexit 1\n',
    { mode: 0o755 },
  );
}

/** A `gh` that is the CommonJS script `source` (it may `require`, read `process.argv.slice(2)` and `process.exit`). */
export async function writeGhNode(bin: string, source: string): Promise<void> {
  await fs.mkdir(bin, { recursive: true });
  if (isWindows) {
    await fs.writeFile(path.join(bin, 'gh.cjs'), source);
    await fs.writeFile(path.join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0gh.cjs" %*\r\n`);
    return;
  }
  await fs.writeFile(path.join(bin, 'gh'), `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

/** A directory holding only `git`, for a test that needs git but no `gh`. POSIX: a symlink. Windows: git's own folder. */
export async function gitOnlyDir(bin: string): Promise<string> {
  const { execa } = await import('execa');
  if (isWindows) {
    // git's own folder (`...\cmd`) holds git.exe and no gh
    const found = (await execa('where', ['git'])).stdout.split(/\r?\n/)[0]!.trim();
    return path.dirname(found);
  }
  const gitPath = (await execa('which', ['git'])).stdout.trim();
  await fs.mkdir(bin, { recursive: true });
  await fs.symlink(gitPath, path.join(bin, 'git'));
  return bin;
}
