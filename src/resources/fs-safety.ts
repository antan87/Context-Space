import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { debugLog } from '../utils/debug.js';

export function assertPathWithin(rootDir: string, targetPath: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetPath}" is outside the allowed root.`);
  }
  return target;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

/** Reads no more than maximumBytes from an already-open descriptor. */
export async function readFileHandleAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('A positive safe byte limit is required.');
  const output = Buffer.alloc(maximumBytes);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return output.subarray(0, offset);
}

/** Confirms an open descriptor still names the same regular, non-linked path. */
export async function assertFileHandleMatchesPath(handle: FileHandle, filePath: string): Promise<BigIntStats> {
  // The parent can itself be replaced after the file was opened. Never wait
  // on a FIFO here, and require a directory where supported. The trusted
  // root may itself be linked; component containment is checked by callers.
  const parentHandle = await fs.open(path.dirname(filePath), constants.O_RDONLY
    | (constants.O_NONBLOCK || 0) | (constants.O_DIRECTORY || 0));
  try {
    const [handleStats, pathStats, parentStats] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(filePath, { bigint: true }),
      parentHandle.stat({ bigint: true }),
    ]);
    // Node 22 can report lstat().dev as zero on Windows. The open parent has the
    // real volume identity, while the bigint inode still binds the path entry.
    const pathDeviceMatches = pathStats.dev === 0n || handleStats.dev === pathStats.dev;
    if (!handleStats.isFile()
      || !pathStats.isFile()
      || pathStats.isSymbolicLink()
      || !parentStats.isDirectory()
      || handleStats.dev !== parentStats.dev
      || !pathDeviceMatches
      || handleStats.ino !== pathStats.ino) {
      throw new Error(`Open file no longer matches its regular path: ${filePath}`);
    }
    return handleStats;
  } finally {
    await parentHandle.close().catch(() => {});
  }
}

/**
 * Rejects symlink/junction components below a trusted root. Missing trailing
 * components are allowed because callers may create them after this check.
 */
export async function assertNoLinkedPathComponents(rootDir: string, targetPath: string): Promise<void> {
  const root = path.resolve(rootDir);
  const target = assertPathWithin(root, targetPath);
  const canonicalRoot = await fs.realpath(root);
  const relative = path.relative(root, target);
  if (!relative) return;

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Linked path components are not allowed in managed resource paths: ${current}`);
      }
      const canonicalCurrent = await fs.realpath(current);
      assertPathWithin(canonicalRoot, canonicalCurrent);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }
}

export async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular file: ${filePath}`);
  }
}

export async function assertPathIsNotLink(targetPath: string): Promise<void> {
  try {
    if ((await fs.lstat(targetPath)).isSymbolicLink()) {
      throw new Error(`Linked managed roots are not allowed: ${targetPath}`);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

async function safeRename(source: string, destination: string): Promise<void> {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 15));
        continue;
      }
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        await fs.copyFile(source, destination);
        await fs.unlink(source).catch(() => {});
        return;
      }
      throw error;
    }
  }
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  beforeCommit?: () => Promise<void>,
  /** The permission bits the new file gets (the file it replaces keeps none of its own: it is a new file). */
  options: { mode?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    if (options.mode === undefined) await fs.writeFile(tempPath, data);
    else {
      await fs.writeFile(tempPath, data, { mode: options.mode });
      // the umask does not apply: the bits are the old file's. Best effort: a file system without permission bits
      // (FAT, some network mounts) refuses chmod, and the save still goes ahead.
      await fs.chmod(tempPath, options.mode).catch((error: unknown) => debugLog('fs-safety', `could not keep the mode of ${filePath}`, error));
    }
    await beforeCommit?.();
    await safeRename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Flushes a folder's entries (a rename or a new name in it) to the disk, so they survive a power cut. Windows cannot
 * open a folder for fsync (NTFS keeps its metadata in its own journal), so there it does nothing; a file system that
 * does not support it (EINVAL, ENOTSUP) is skipped too.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    // Best effort: a mount that refuses a folder fsync (EPERM, EACCES, EBADF on some network and FUSE file systems)
    // must not stop a move or a restore every time. The file's own bytes were flushed already; only the folder entry
    // may not be on the disk yet. Logged for --debug.
    debugLog('fs-safety', `could not flush the folder ${dir}`, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Writes a file's bytes and flushes them to the disk before it returns (used for a temp file that is renamed or linked into place). */
export async function writeFileSynced(filePath: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const handle = await fs.open(filePath, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * {@link atomicWriteFile} that also survives a power cut: the temp file's bytes are flushed before the rename, and the
 * folder after it. Without that, ext4 with delayed allocation can show the new name with no bytes after a crash, and
 * APFS and NTFS promise no order either. Slower than a plain atomic write: for records whose loss would leave a
 * workspace stuck (the database switch, an archive's manifest), not for every save.
 */
export async function durableWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFileSynced(tempPath, data);
    await safeRename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
