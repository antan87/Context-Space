/** Read-only workspace-owned files. Repository roots remain under repository APIs. */
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { loadWorkspaceManifest } from './workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { isClosedSegment, IGNORED_DIRECTORIES } from './root-documents.js';
import { assertPathWithin, assertNoLinkedPathComponents, assertRegularFile, assertFileHandleMatchesPath, readFileHandleAtMost } from '../resources/fs-safety.js';
import { looksBinary, MAX_VIEWABLE_FILE_BYTES } from '../services/repository-file.js';

const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 5;
const within = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export async function workspaceFileScope(root: string) {
  const feature = await loadWorkspaceManifest(root);
  if (!feature || !Array.isArray(feature.repos) || feature.repos.some((repo) => typeof repo !== 'string' || !path.isAbsolute(repo))
    || (feature.originalRepos !== undefined && (!Array.isArray(feature.originalRepos) || feature.originalRepos.some((repo) => typeof repo !== 'string' || !path.isAbsolute(repo))))
    || (feature.mode !== 'worktree' && feature.mode !== 'in-place')) throw new Error('Workspace repository configuration is unavailable.');
  if (feature.isolatedRepos && (typeof feature.isolatedRepos !== 'object' || Object.values(feature.isolatedRepos).some((repo) => !repo || typeof repo.worktreePath !== 'string' || !path.isAbsolute(repo.worktreePath)))) {
    throw new Error('Workspace repository configuration is unavailable.');
  }
  const roots = [
    ...feature.repos.flatMap((repo) => [path.resolve(repo), path.resolve(resolveFeatureRepoPath(feature, root, repo))]),
    ...(feature.originalRepos ?? []).map((repo) => path.resolve(repo)),
  ];
  return { feature, excluded: (target: string) => roots.some((repo) => within(repo, target)) };
}

export function checkedWorkspaceFilePath(root: string, name: string) {
  const parts = name.split('/');
  if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || path.isAbsolute(name) || parts.some((part) => !part || part === '.' || part === '..' || isClosedSegment(part) || IGNORED_DIRECTORIES.has(part))) {
    throw new Error('Choose a visible file inside this workspace.');
  }
  return assertPathWithin(root, path.resolve(root, ...parts));
}

export interface WorkspaceFileEntry {
  path: string;
  modifiedAt: string;
  size: number;
}

export async function listWorkspaceFiles(root: string) {
  const { excluded } = await workspaceFileScope(root);
  const files: WorkspaceFileEntry[] = [];
  const errors: string[] = [];
  let entries = 0;
  let truncated = false;
  async function scan(dir: string, prefix: string, depth: number) {
    if (excluded(dir)) return;
    await assertNoLinkedPathComponents(root, dir);
    const handle = await fs.opendir(dir);
    try {
      for await (const entry of handle) {
        if (++entries > MAX_ENTRIES) { truncated = true; break; }
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        let target: string;
        try { target = checkedWorkspaceFilePath(root, name); } catch { continue; }
        if (excluded(target) || entry.isSymbolicLink()) continue;
        try {
          await assertNoLinkedPathComponents(root, target);
          const stat = await fs.lstat(target);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            if (depth >= MAX_DEPTH) truncated = true;
            else await scan(target, name, depth + 1);
          } else if (stat.isFile()) files.push({ path: name, modifiedAt: stat.mtime.toISOString(), size: stat.size });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`Could not scan ${name}.`);
        }
        if (entries > MAX_ENTRIES) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await scan(root, '', 0);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated, errors: errors.sort(), limits: { depth: MAX_DEPTH, entries: MAX_ENTRIES } };
}

/**
 * A cheap fingerprint of what {@link listWorkspaceFiles} would show: the same folders, hidden and ignored names and
 * repository exclusions, the same limits, from names, sizes and modification times only. It reads no file contents,
 * and opens no file. It differs when a listed file is added, removed or changed. `scope` may be passed to spare the
 * manifest read.
 */
export async function workspaceFilesSignature(root: string, scope?: Pick<Awaited<ReturnType<typeof workspaceFileScope>>, 'excluded'>): Promise<string> {
  const { excluded } = scope ?? await workspaceFileScope(root);
  const hash = createHash('sha1');
  let entries = 0;
  async function scan(dir: string, prefix: string, depth: number): Promise<void> {
    if (excluded(dir)) return;
    let children;
    try { children = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const folders: Array<{ target: string; name: string }> = [];
    const stats: Promise<void>[] = [];
    const parts: string[] = [];
    for (const entry of children) {
      if (++entries > MAX_ENTRIES) return;
      if (entry.isSymbolicLink() || isClosedSegment(entry.name) || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(dir, entry.name);
      if (excluded(target)) continue;
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) folders.push({ target, name }); }
      else if (entry.isFile()) {
        const index = parts.push('') - 1;
        stats.push(fs.lstat(target).then((s) => { parts[index] = `${name}:${s.size}:${s.mtimeMs}`; }, () => { parts[index] = `${name}:gone`; }));
      }
    }
    await Promise.all(stats);
    hash.update(`${prefix}/${parts.join(',')};`);
    for (const folder of folders) await scan(folder.target, folder.name, depth + 1);
  }
  await scan(root, '', 0);
  return hash.digest('hex');
}

export async function readWorkspaceFile(root: string, name: string) {
  const { excluded } = await workspaceFileScope(root);
  const target = checkedWorkspaceFilePath(root, name);
  if (excluded(target)) throw new Error('This file belongs to a repository.');
  await assertNoLinkedPathComponents(root, target);
  await assertRegularFile(target); // Before open: FIFOs and other special files must never block.
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await assertFileHandleMatchesPath(handle, target);
    await assertNoLinkedPathComponents(root, target);
    if (stat.size > BigInt(MAX_VIEWABLE_FILE_BYTES)) return { content: '', omitted: 'too-large' as const };
    const bytes = await readFileHandleAtMost(handle, MAX_VIEWABLE_FILE_BYTES + 1);
    await assertFileHandleMatchesPath(handle, target);
    await assertNoLinkedPathComponents(root, target);
    if (bytes.length > MAX_VIEWABLE_FILE_BYTES) return { content: '', omitted: 'too-large' as const };
    if (looksBinary(bytes)) return { content: '', omitted: 'binary' as const };
    return { content: bytes.toString('utf8') };
  } finally { await handle.close(); }
}
