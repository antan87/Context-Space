import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DETECTION_TTL_MS, clearEditorDetectionCache, detectEditors } from './detect-editors.js';

vi.mock('execa');

const isWin = process.platform === 'win32';
let bin: string;
let savedPath: string | undefined;

/** Puts an executable named `command` on the test PATH. */
async function install(command: string) {
  const file = path.join(bin, isWin ? `${command}.cmd` : command);
  await fs.writeFile(file, isWin ? '@echo off\r\n' : '#!/bin/sh\n');
  if (!isWin) await fs.chmod(file, 0o755);
}

const shells = isWin ? [{ name: 'PowerShell', command: 'powershell', detected: true }, { name: 'Command Prompt', command: 'cmd', detected: true }] : [];
const expected = (installed: string[]) => [
  { name: 'VS Code', command: 'code' },
  { name: 'VS Code Insiders', command: 'code-insiders' },
  { name: 'Cursor', command: 'cursor' },
  { name: 'Antigravity', command: 'antigravity' },
  ...shells,
  { name: 'IntelliJ IDEA', command: 'idea' },
  { name: 'WebStorm', command: 'webstorm' },
  { name: 'PyCharm', command: 'charm' },
  { name: 'Sublime Text', command: 'subl' },
  { name: 'Zed', command: 'zed' },
  { name: 'Windsurf', command: 'windsurf' },
].map((editor) => ('detected' in editor ? editor : { ...editor, detected: installed.includes(editor.command) }));

describe('detectEditors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearEditorDetectionCache();
    vi.useRealTimers();
    bin = await fs.mkdtemp(path.join(os.tmpdir(), 'editors-'));
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await fs.rm(bin, { recursive: true, force: true });
  });

  it('detects the editors whose command is on PATH, without starting any of them', async () => {
    await install('code');
    await install('cursor');

    expect(await detectEditors()).toEqual(expected(['code', 'cursor']));
    expect(execa).not.toHaveBeenCalled();
  });

  it('detects none when nothing is on PATH (the built-in Windows shells excepted)', async () => {
    expect(await detectEditors()).toEqual(expected([]));
  });

  if (!isWin) {
    it('does not count a file on PATH that cannot be run', async () => {
      await fs.writeFile(path.join(bin, 'zed'), '#!/bin/sh\n');
      expect((await detectEditors()).find((e) => e.command === 'zed')?.detected).toBe(false);
    });
  }

  it('shares one run between concurrent callers and reuses it for 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [first, second] = await Promise.all([detectEditors(), detectEditors()]);
    expect(second).toBe(first);

    await install('code');
    vi.setSystemTime(Date.now() + DETECTION_TTL_MS - 1_000);
    expect((await detectEditors()).find((e) => e.command === 'code')?.detected).toBe(false);

    vi.setSystemTime(Date.now() + 2_000);
    expect((await detectEditors()).find((e) => e.command === 'code')?.detected).toBe(true);
  });
});
