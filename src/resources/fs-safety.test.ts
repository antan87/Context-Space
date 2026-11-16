import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { execa } from 'execa';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertFileHandleMatchesPath, assertNoLinkedPathComponents, assertPathWithin, atomicWriteFile, readFileHandleAtMost } from './fs-safety.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const target of cleanupPaths.splice(0)) {
    const resolved = path.resolve(target);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
});

describe('filesystem safety', () => {
  it('supports filesystem roots without admitting sibling paths or traversal', () => {
    const root = path.parse(path.resolve(os.tmpdir())).root;
    expect(assertPathWithin(root, os.tmpdir())).toBe(path.resolve(os.tmpdir()));
    const managed = path.join(os.tmpdir(), 'managed');
    expect(() => assertPathWithin(managed, `${managed}-other/file`)).toThrow('outside');
    expect(() => assertPathWithin(managed, path.join(managed, '..', 'outside'))).toThrow('outside');
  });
  it('matches a normal file descriptor to its path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-matching-file-'));
    cleanupPaths.push(root);
    const filePath = path.join(root, 'resource.txt');
    await fs.writeFile(filePath, 'resource', 'utf8');
    const handle = await fs.open(filePath, 'r');
    try {
      await expect(assertFileHandleMatchesPath(handle, filePath)).resolves.toMatchObject({ size: 8n });
    } finally {
      await handle.close();
    }
  });

  it('allows a trusted root that is itself a symlink or junction', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-linked-root-'));
    cleanupPaths.push(root);
    const real = path.join(root, 'real'); await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'resource.txt'), 'resource');
    const alias = path.join(root, 'alias');
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(alias, 'resource.txt');
    await assertNoLinkedPathComponents(alias, target);
    const handle = await fs.open(target, 'r');
    try {
      await expect(assertFileHandleMatchesPath(handle, target)).resolves.toMatchObject({ size: 8n });
    } finally {
      await handle.close();
    }
  });

  it('never reads beyond its byte limit when an open file grows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-bounded-read-'));
    cleanupPaths.push(root);
    const filePath = path.join(root, 'growing.txt');
    await fs.writeFile(filePath, 'ok', 'utf8');
    const handle = await fs.open(filePath, 'r');
    try {
      expect((await handle.stat()).size).toBe(2);
      await fs.appendFile(filePath, Buffer.alloc(1024 * 1024, 0x61));
      const bytes = await readFileHandleAtMost(handle, 9);
      expect(bytes).toHaveLength(9);
      expect(bytes.subarray(0, 2).toString('utf8')).toBe('ok');
    } finally {
      await handle.close();
    }
  });

  it('rejects a symlink or junction in a path below the trusted root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-linked-path-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-linked-path-outside-'));
    cleanupPaths.push(root, outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    const linkedDirectory = path.join(root, 'linked');
    await fs.symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(assertNoLinkedPathComponents(root, path.join(linkedDirectory, 'secret.txt')))
      .rejects.toThrow(/linked path components/i);
  });

  it('rejects a path replaced after its original file descriptor was opened', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-replaced-file-'));
    cleanupPaths.push(root);
    const filePath = path.join(root, 'resource.txt');
    const movedPath = path.join(root, 'resource.original.txt');
    await fs.writeFile(filePath, 'original', 'utf8');
    const handle = await fs.open(filePath, 'r');
    try {
      await fs.rename(filePath, movedPath);
      await fs.writeFile(filePath, 'replacement', 'utf8');
      await expect(assertFileHandleMatchesPath(handle, filePath)).rejects.toThrow(/no longer matches/i);
    } finally {
      await handle.close();
    }
  });

  it.skipIf(process.platform === 'win32')('never blocks opening a parent directory replaced by a FIFO', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-parent-fifo-'));
    cleanupPaths.push(root);
    const parent = path.join(root, 'parent'); await fs.mkdir(parent);
    const target = path.join(parent, 'resource.txt'); await fs.writeFile(target, 'original');
    const handle = await fs.open(target, 'r');
    await fs.rename(parent, path.join(root, 'moved'));
    await execa('mkfifo', [parent]);
    const open = fs.open; const blocking: string[] = [];
    let attempts = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === parent) {
        attempts += 1;
        if (typeof args[1] !== 'number' || !(args[1] & constants.O_NONBLOCK)) {
          blocking.push('blocking FIFO parent open'); throw new Error('Prevent a hanging test');
        }
      }
      return open(...args);
    });
    try {
      await expect(assertFileHandleMatchesPath(handle, target)).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(blocking).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('atomically creates and replaces files via atomicWriteFile', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-atomic-write-'));
    cleanupPaths.push(root);
    const filePath = path.join(root, 'target.txt');
    await atomicWriteFile(filePath, 'hello world');
    expect(await fs.readFile(filePath, 'utf8')).toBe('hello world');

    await atomicWriteFile(filePath, 'updated content');
    expect(await fs.readFile(filePath, 'utf8')).toBe('updated content');
  });
});
