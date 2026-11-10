import { execa } from 'execa';

export const UNTRACKED_COUNT_LIMIT = 256 * 1024;

export interface ListedFileInspection {
  file: string;
  size: number;
  mtimeMs: number;
  additions?: number;
}

/**
 * Inspect listed data through stable parent directories, never a rechecked
 * absolute pathname. One isolated child per phase owns its cwd; the server's
 * cwd is untouched. Missing/unsafe files and uncountable contents are omitted.
 */
export async function inspectListedRepositoryFiles(
  repoPath: string,
  files: string[],
  mode: 'metadata' | 'counts',
): Promise<ListedFileInspection[]> {
  if (files.length === 0) return [];
  const input = JSON.stringify({ repoPath, files, mode, limit: UNTRACKED_COUNT_LIMIT });
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error('Repository inspection input is too large.');
  const { stdout } = await execa(process.execPath, ['--input-type=commonjs', '-e', `(${inspectInChild.toString()})()`], {
    input,
    timeout: 30_000,
    // Output is one small metadata row per input path; no contents cross IPC.
    maxBuffer: Math.min(32 * 1024 * 1024, Math.max(1024 * 1024, Buffer.byteLength(input) * 4 + files.length * 160)),
  });
  return JSON.parse(stdout) as ListedFileInspection[];
}

// Self-contained so source tests and compiled deployments execute the same
// child implementation without a second script, loader or build-time asset.
function inspectInChild(): void {
  const fs: typeof import('node:fs') = require('node:fs');
  const path: typeof import('node:path') = require('node:path');
  const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
    repoPath: string; files: string[]; mode: 'metadata' | 'counts'; limit: number;
  };
  const root = fs.realpathSync.native(input.repoPath);
  const rows: ListedFileInspection[] = [];
  const within = (target: string): boolean => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const samePath = (left: string, right: string): boolean => path.relative(left, right) === '';
  for (const file of input.files) {
    let fd: number | undefined;
    try {
      if (path.isAbsolute(file)) continue;
      const target = path.resolve(root, file);
      if (!within(target)) continue;
      const parent = path.dirname(target);
      let component = root;
      for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
        component = path.join(component, segment);
        const stat = fs.lstatSync(component);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked parent');
      }
      process.chdir(parent);
      // Native realpath('.') observes the actual cwd, not Node's cached lexical
      // cwd. POSIX cwd is a directory reference; Windows SetCurrentDirectoryW
      // locks that directory. Node/libuv pass basename paths to the OS intact.
      const actualParent = fs.realpathSync.native('.');
      if (!within(actualParent) || !samePath(actualParent, parent)) continue;
      // From here all filesystem names are relative to the anchored cwd. A
      // rename/symlink swap of an ancestor cannot redirect these operations.
      const name = path.basename(target);
      if (!fs.lstatSync(name).isFile()) continue;
      fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      const entry = fs.lstatSync(name, { bigint: true });
      const directory = fs.statSync('.', { bigint: true });
      if (!opened.isFile() || !entry.isFile() || entry.isSymbolicLink()
        || opened.ino !== entry.ino || opened.dev !== directory.dev
        || (entry.dev !== 0n && opened.dev !== entry.dev)) continue;
      const stat = fs.fstatSync(fd);
      const row: ListedFileInspection = { file, size: stat.size, mtimeMs: stat.mtimeMs };
      if (input.mode === 'counts' && stat.size <= input.limit) {
        const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, input.limit + 1));
        let total = 0; let lines = 0; let last = -1; let binary = false;
        while (total <= input.limit) {
          const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, input.limit + 1 - total), null);
          if (read === 0) break;
          total += read;
          for (let index = 0; index < read; index++) {
            const byte = buffer[index]!;
            if (byte === 0) binary = true;
            if (byte === 10) lines += 1;
          }
          last = buffer[read - 1]!;
        }
        if (!binary && total <= input.limit) row.additions = lines + (total === 0 || last === 10 ? 0 : 1);
      }
      rows.push(row);
    } catch {
      // Deleted, linked, replaced or nonregular data has no safe metadata/count.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  process.stdout.write(JSON.stringify(rows));
}
