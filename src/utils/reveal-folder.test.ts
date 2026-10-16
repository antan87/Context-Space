import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';

import { fileManagerCommand, revealFolder } from './reveal-folder.js';

describe('fileManagerCommand', () => {
  it('uses the file manager of each platform', () => {
    expect(fileManagerCommand('linux', '/skills/pdf')).toEqual({ command: 'xdg-open', args: ['/skills/pdf'] });
    expect(fileManagerCommand('darwin', '/skills/pdf')).toEqual({ command: 'open', args: ['/skills/pdf'] });
    expect(fileManagerCommand('win32', 'C:\\skills\\pdf')).toEqual({ command: 'explorer.exe', args: ['C:\\skills\\pdf'] });
  });
});

describe('revealFolder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-folder-'));
  });

  afterEach(async () => {
    await fse.remove(dir);
  });

  it('refuses a folder that does not exist, and never starts a file manager for it', async () => {
    await expect(revealFolder(path.join(dir, 'gone'))).rejects.toThrow(/no longer exists/);
  });

  it('refuses a file where a folder is expected', async () => {
    const file = path.join(dir, 'SKILL.md');
    await fs.writeFile(file, 'x');
    await expect(revealFolder(file)).rejects.toThrow(/no longer exists/);
  });
});
