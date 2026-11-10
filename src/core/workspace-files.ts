/** Read-only workspace-owned files. Repository roots remain under repository APIs. */
import * as fs from 'node:fs/promises';
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

export async function listWorkspaceFiles(root: string) {
  const { excluded } = await workspaceFileScope(root);
  const files: Array<{ path: string }> = [];
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
          } else if (stat.isFile()) files.push({ path: name });
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
