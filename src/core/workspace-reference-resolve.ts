import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { checkedWorkspaceFilePath, workspaceFileScope } from './workspace-files.js';
import { openableDocumentName } from './root-documents.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { assertNoLinkedPathComponents } from '../resources/fs-safety.js';

export type ReferenceOrigin =
  | { kind: 'workspace'; workspacePath: string }
  | { kind: 'repository'; repoName: string; repoPath: string };
export interface WorkspaceReferenceTarget {
  origin: ReferenceOrigin;
  file: string;
  /** Default only: callers decide how an explicit line/column affects presentation. */
  viewer: 'reader' | 'code';
}
export type WorkspaceReferenceResolution =
  | { status: 'found'; target: WorkspaceReferenceTarget }
  | { status: 'ambiguous'; candidates: WorkspaceReferenceTarget[]; truncated: boolean }
  | { status: 'not-found'; reason: 'missing' | 'directory' | 'outside-roots' };
export interface ReferenceRepository { repoName: string; repoPath: string }
export interface WorkspaceReferenceOptions {
  cwd?: string;
  listFiles?: (repo: ReferenceRepository) => Promise<readonly string[]>;
}

const DOCUMENT = /\.(?:md|markdown|mdx|txt|rst|adoc|csv|tsv|log|svg|mmd|html?|png|jpe?g|gif|webp|pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/i;
const MAX_CANDIDATES = 20;
const key = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
const within = (root: string, target: string) => {
  const rel = path.relative(key(root), key(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const unsafe = (name: string) => /[:\x00-\x1f\x7f]/.test(name);
// Only the native absolute drive prefix is syntax, never an alternate data stream.
// UNC paths use the native path implementation and still need to land in a trusted root.
const unsafeReference = (name: string) => unsafe(process.platform === 'win32' && /^[a-z]:\//i.test(name) ? name.slice(2) : name);

/** Metadata only. The serving routes still revalidate paths, types, content and size at read time. */
export async function resolveWorkspaceReference(root: string, raw: string, options: WorkspaceReferenceOptions = {}): Promise<WorkspaceReferenceResolution> {
  root = path.resolve(root);
  const { feature, excluded } = await workspaceFileScope(root);
  const repos = feature.repos.map((stored) => ({
    repoName: path.basename(stored), repoPath: path.resolve(resolveFeatureRepoPath(feature, root, stored)),
    aliases: [path.resolve(stored)],
  }));
  // A name is also the reader's repository selector. Never return a selector that cannot identify one repo.
  const names = repos.map((repo) => repo.repoName.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('Ambiguous repository configuration.');
  if (repos.some((repo) => !repo.repoName || repo.repoName === '.' || repo.repoName === '..' || /[\\/:\x00-\x1f\x7f]/.test(repo.repoName))
    || Array.isArray(feature.isolatedRepos)) throw new Error('Invalid repository configuration.');
  for (const original of feature.originalRepos ?? []) {
    const matches = repos.filter((repo) => key(repo.repoName) === key(path.basename(original)));
    if (matches.length === 1) {
      if ((feature.originalRepos ?? []).filter((entry) => key(path.basename(entry)) === key(path.basename(original))).length > 1) {
        throw new Error('Ambiguous repository aliases.');
      }
      matches[0]!.aliases.push(path.resolve(original));
    }
  }
  const aliasOwners = new Map<string, string>();
  for (const repo of repos) {
    repo.aliases = [...new Set(repo.aliases)].filter((alias) => key(alias) !== key(repo.repoPath));
    for (const alias of repo.aliases) {
      const owner = aliasOwners.get(key(alias));
      if (owner && owner !== key(repo.repoPath)) throw new Error('Ambiguous repository aliases.');
      aliasOwners.set(key(alias), key(repo.repoPath));
    }
  }
  const target = raw.replace(/\\/g, '/');
  const cwd = options.cwd?.replace(/\\/g, '/');
  if (!target || unsafeReference(target) || (cwd !== undefined && (unsafeReference(cwd) || !path.isAbsolute(cwd)))) {
    return { status: 'not-found', reason: 'missing' };
  }
  let sawDirectory = false;
  let inside = false;
  async function inspect(candidate: string, repo?: typeof repos[number]): Promise<WorkspaceReferenceTarget | null> {
    const base = repo?.repoPath ?? root;
    if (!within(base, candidate)) return null;
    if (!repo && excluded(candidate)) return null;
    inside = true;
    const file = path.relative(base, candidate).split(path.sep).join('/');
    const viewer = DOCUMENT.test(file) ? 'reader' : 'code';
    try {
      if (!repo) checkedWorkspaceFilePath(root, file);
      if (!file || unsafe(file)) return null;
      if (viewer === 'reader') {
        openableDocumentName(file);
        // The streaming reader permits an assistant folder only as the first segment.
        if (file.split('/').slice(1).some((part) => part.startsWith('.'))) return null;
        // The reader's view-link boundary excludes nested configured checkouts too.
        if (repo && repos.some((other) => other !== repo && key(other.repoPath) !== key(base)
          && within(base, other.repoPath) && within(other.repoPath, candidate))) return null;
      }
      await assertNoLinkedPathComponents(base, candidate);
      const stat = await fs.lstat(candidate);
      if (stat.isDirectory()) { sawDirectory = true; return null; }
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return { origin: repo ? { kind: 'repository', repoName: repo.repoName, repoPath: repo.repoPath } : { kind: 'workspace', workspacePath: root }, file, viewer };
    } catch { return null; }
  }
  async function absolute(candidate: string): Promise<WorkspaceReferenceTarget[]> {
    const actual = repos.filter((repo) => within(repo.repoPath, candidate));
    if (actual.length) return (await Promise.all(actual.map((repo) => inspect(candidate, repo)))).filter((entry) => entry !== null);
    const aliases = repos.flatMap((repo) => repo.aliases.filter((alias) => within(alias, candidate)).map((alias) => ({ repo, alias })));
    if (aliases.length > 1) throw new Error('Ambiguous repository aliases.');
    if (aliases.length) {
      const { repo, alias } = aliases[0]!;
      const match = await inspect(path.resolve(repo.repoPath, path.relative(alias, candidate)), repo);
      return match ? [match] : [];
    }
    const match = await inspect(candidate);
    return match ? [match] : [];
  }
  function result(candidates: WorkspaceReferenceTarget[]): WorkspaceReferenceResolution | null {
    const unique = [...new Map(candidates.map((entry) => [JSON.stringify(entry), entry])).values()];
    if (unique.length === 1) return { status: 'found', target: unique[0]! };
    if (unique.length > 1) return { status: 'ambiguous', candidates: unique.slice(0, MAX_CANDIDATES), truncated: unique.length > MAX_CANDIDATES };
    return null;
  }
  const missing = (): WorkspaceReferenceResolution => ({ status: 'not-found', reason: sawDirectory ? 'directory' : inside ? 'missing' : 'outside-roots' });
  // Absolute and cwd-relative paths are authoritative: never fall back to an unrelated same-name file.
  if (path.isAbsolute(target)) return result(await absolute(path.resolve(target))) ?? missing();
  if (cwd) return result(await absolute(path.resolve(cwd, target))) ?? missing();
  const normalized = target.replace(/^\.\//, '');
  const [first, ...rest] = normalized.split('/');
  const qualified = repos.find((repo) => key(repo.repoName) === key(first ?? ''));
  if (qualified && rest.length) {
    const match = await inspect(path.resolve(qualified.repoPath, rest.join('/')), qualified);
    return result(match ? [match] : []) ?? missing();
  }
  // Parent traversal is meaningful only with a known cwd; it must not select another root.
  if (normalized.split('/').includes('..')) return { status: 'not-found', reason: 'outside-roots' };
  const exact = await absolute(path.resolve(root, target));
  for (const repo of repos) {
    const match = await inspect(path.resolve(repo.repoPath, target), repo);
    if (match) exact.push(match);
  }
  const matched = result(exact);
  if (matched) return matched;
  if (options.listFiles) {
    const suffix: WorkspaceReferenceTarget[] = [];
    for (const repo of repos) {
      // A failed/oversized listing can hide another match. Do not claim uniqueness from incomplete roots.
      const files = await options.listFiles(repo);
      for (const file of files) {
        if (path.isAbsolute(file) || unsafe(file) || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) continue;
        if (key(file) !== key(normalized) && !key(file).endsWith(`/${key(normalized)}`)) continue;
        const match = await inspect(path.resolve(repo.repoPath, file), repo);
        if (match) suffix.push(match);
        if (suffix.length > MAX_CANDIDATES) return result(suffix)!;
      }
    }
    const matchedSuffix = result(suffix);
    if (matchedSuffix) return matchedSuffix;
  }
  return missing();
}
