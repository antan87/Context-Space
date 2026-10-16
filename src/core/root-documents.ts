import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { assertFileHandleMatchesPath, assertNoLinkedPathComponents, readFileHandleAtMost } from '../resources/fs-safety.js';

const textExtensions = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.csv', '.tsv', '.log', '.svg', '.mmd']);
/**
 * Plain-text data an assistant writes next to its documents: a spec, a schema, a config. They open in the viewer like any
 * text, but a repository has many of them (package.json, tsconfig.json), so the listing leaves out the ones in a repository.
 */
const dataExtensions = new Set(['.json', '.yaml', '.yml', '.toml', '.xml']);
const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const officeExtensions = new Set(['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * Hidden folders whose files are documents too: where assistants keep their skills, workflows and notes. Every other
 * hidden name (.git, .contextspace, .vscode, .env, .private.md) stays closed. Listing and opening use the one rule, so a
 * document that opens is also found in the tree.
 */
const OPEN_HIDDEN_FOLDERS = new Set(['.claude', '.agents', '.github']);
const HIDDEN_REASON = "Hidden files and folders can't be opened here, except the folders .claude, .agents and .github.";
const isClosedSegment = (segment: string) => segment.startsWith('.') && !OPEN_HIDDEN_FOLDERS.has(segment);

function format(name: string) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.html' || extension === '.htm') return { kind: 'html', mime: 'text/html; charset=utf-8' } as const;
  if (textExtensions.has(extension)) return { kind: extension === '.md' || extension === '.markdown' ? 'markdown' : 'text', mime: 'text/plain; charset=utf-8' } as const;
  if (dataExtensions.has(extension)) return { kind: 'text', mime: 'text/plain; charset=utf-8' } as const;
  if (extension === '.pdf') return { kind: 'pdf', mime: 'application/pdf' } as const;
  if (images[extension]) return { kind: 'image', mime: images[extension] } as const;
  if (officeExtensions.has(extension)) return { kind: 'download', mime: 'application/octet-stream' } as const;
  return null;
}

/**
 * `name` is a workspace-relative path with `/` separators. Nested files are
 * allowed so document links (e.g. screenshots) can open in the viewer, but no
 * segment may be `..`, empty, hidden (`.git`; only `.claude`, `.agents` and `.github` are open),
 * or carry Windows drive/stream syntax. Links on disk are rejected by the callers' safety checks.
 */
function documentPath(root: string, name: string) {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || path.isAbsolute(normalized) || /[:\x00-\x1f\x7f]/.test(normalized) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Choose a document inside this workspace.');
  }
  if (segments.some(isClosedSegment)) throw new Error(`Choose a document inside this workspace. ${HIDDEN_REASON}`);
  if (!format(normalized)) throw new Error(`${path.extname(normalized) || 'This'} files can't be opened here. Open it from the workspace folder instead.`);
  return path.join(root, ...segments);
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.contextspace',
  '.vscode',
  '.idea',
]);

function folderPath(root: string, folder: string) {
  if (!folder) return root;
  const normalized = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return root;
  const segments = normalized.split('/');
  if (path.isAbsolute(normalized) || /[:\x00-\x1f\x7f]/.test(normalized) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Choose a folder inside this workspace.');
  }
  if (segments.some(isClosedSegment)) throw new Error(`Choose a folder inside this workspace. ${HIDDEN_REASON}`);
  return path.join(root, ...segments);
}

const isDataFile = (name: string) => dataExtensions.has(path.extname(name).toLowerCase());

export interface ListRootDocumentsOptions {
  /** Workspace-relative folders (with `/`) that hold a repository; the data files inside them are not listed. */
  repoFolders?: readonly string[];
}

/** Agent-created files are local files, not copies registered with a storage adapter. */
export async function listRootDocuments(root: string, folder = '', recursive = false, options: ListRootDocumentsOptions = {}) {
  const repoFolders = (options.repoFolders ?? []).map((repoFolder) => repoFolder.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const inRepository = (rel: string) => repoFolders.some((repoFolder) => rel === repoFolder || rel.startsWith(`${repoFolder}/`));
  const normalizedFolder = folder ? folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
  const targetDir = folderPath(root, normalizedFolder);
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Choose a folder inside this workspace.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Folder not found.');
    }
    throw error;
  }
  await assertNoLinkedPathComponents(root, targetDir);

  const documents: Array<{ name: string; size: number; modifiedAt: string; kind: 'html' | 'markdown' | 'text' | 'pdf' | 'image' | 'download'; mime: string }> = [];
  const folders: string[] = [];

  async function scan(dir: string, currentPrefix: string, depth = 0) {
    if (depth > 5) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (isClosedSegment(entry.name) || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const rel = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          folders.push(rel);
          if (recursive) {
            await scan(full, rel, depth + 1);
          }
        } else if (stat.isFile() && format(entry.name)) {
          // ContextSpace's own store files (contextspace.json, contextspace-plan.json, …) are not documents to read or edit by hand,
          // and a data file in a hidden folder (.claude/settings.json, .github/workflows/ci.yml) is configuration.
          if (isDataFile(entry.name) && (inRepository(rel) || rel.split('/').some((segment) => segment.startsWith('.')) || (!currentPrefix && /^contextspace/i.test(entry.name)))) continue;
          documents.push({ name: rel, size: stat.size, modifiedAt: stat.mtime.toISOString(), ...format(entry.name)! });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  await scan(targetDir, normalizedFolder, 0);

  return {
    documents: documents.sort((a, b) => a.name.localeCompare(b.name)),
    folders: folders.sort((a, b) => a.localeCompare(b)),
  };
}

export async function readRootDocument(root: string, name: string, download = false) {
  const normalizedName = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = documentPath(root, normalizedName);
  await assertNoLinkedPathComponents(root, target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await assertFileHandleMatchesPath(handle, target);
    const details = format(normalizedName)!;
    const isText = details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html';
    const limit = isText && !download ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
    if (stat.size > BigInt(limit)) throw new Error(`This document exceeds the ${limit / 1024 / 1024} MB ${download ? 'download' : 'preview'} limit.`);
    const bytes = await readFileHandleAtMost(handle, limit + 1);
    await assertNoLinkedPathComponents(root, target);
    await assertFileHandleMatchesPath(handle, target);
    if (bytes.length > limit) throw new Error('The document grew beyond the size limit.');
    return { name: normalizedName, ...details, bytes, content: isText && !download ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined };
  } finally {
    await handle.close();
  }
}
