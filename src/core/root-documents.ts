import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { assertFileHandleMatchesPath, assertNoLinkedPathComponents, atomicWriteFile, readFileHandleAtMost } from '../resources/fs-safety.js';
import { acquireLock, createMutationQueue } from './locks.js';
import { WorkspaceMovedError, readSwitch } from './workspace-db-switch.js';

const textExtensions = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.csv', '.tsv', '.log', '.mmd']);
/**
 * Plain-text data an assistant writes next to its documents: a spec, a schema, a config. They open in the viewer like any
 * text, but a repository has many of them (package.json, tsconfig.json), so the listing leaves out the ones in a repository.
 */
const dataExtensions = new Set(['.json', '.yaml', '.yml', '.toml', '.xml']);
const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
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
export const isClosedSegment = (segment: string) => segment.startsWith('.') && !OPEN_HIDDEN_FOLDERS.has(segment);

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
function checkedDocumentName(name: string, operation: 'open' | 'save' = 'open') {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || path.isAbsolute(normalized) || /[:\x00-\x1f\x7f]/.test(normalized) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Choose a document inside this workspace.');
  }
  if (segments.some(isClosedSegment)) throw new Error(`Choose a document inside this workspace. ${HIDDEN_REASON}`);
  if (operation === 'open' && !format(normalized)) throw new Error(`${path.extname(normalized) || 'This'} files can't be opened here. Open it from the workspace folder instead.`);
  return { normalized, segments };
}

function documentPath(root: string, name: string, operation: 'open' | 'save' = 'open') {
  return path.join(root, ...checkedDocumentName(name, operation).segments);
}

/**
 * Checks a workspace-relative name by the rules the documents panel opens files by, without touching the disk, and
 * returns it with `/` separators. For features that point at a document (the board's file cards), so what they accept
 * is what the panel can open. The callers check the file itself.
 */
export function openableDocumentName(name: string): string {
  return checkedDocumentName(name, 'open').normalized;
}

export const IGNORED_DIRECTORIES = new Set([
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

/**
 * What the documents panel may not save or move: ContextSpace's own store files at the workspace root
 * (`contextspace.json`, `contextspace-board.json`, `contextspace-plan.json`, `contextspace-data.json`, …), which the
 * listing already leaves out; and, while the workspace is moved to its database (or being moved or restored), the plan
 * files the move archives and exports (PLAN.md, the older planning notes).
 */
function refuseStoreFile(root: string, name: string): void {
  const segments = name.split('/');
  if (segments.length !== 1) return;
  if (isDataFile(name) && /^contextspace/i.test(name)) throw new Error(`${name} is ContextSpace's own store file, not a document: change it through ContextSpace.`);
  if (/^(plan\.md|contextspace-milestones\.md)$/i.test(name)) {
    const moved = readSwitch(root);
    if (moved) throw new WorkspaceMovedError(moved);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type DocumentConflictCode = 'CONFLICT' | 'ALREADY_EXISTS';

export class DocumentConflictError extends Error {
  readonly code: DocumentConflictCode;
  readonly currentRevision: string | null;
  readonly currentContent?: string;
  readonly currentModifiedAt?: string | null;

  constructor(
    message: string,
    options: {
      code: DocumentConflictCode;
      currentRevision: string | null;
      currentContent?: string;
      currentModifiedAt?: string | null;
    },
  ) {
    super(message);
    this.name = 'DocumentConflictError';
    this.code = options.code;
    this.currentRevision = options.currentRevision;
    this.currentContent = options.currentContent;
    this.currentModifiedAt = options.currentModifiedAt;
  }
}

export interface DocumentEditability {
  editable: boolean;
  readOnlyReason?: string;
  managed?: boolean;
}

export function documentEditability(
  root: string,
  normalizedName: string,
  options?: { switchedToDb?: boolean },
): DocumentEditability {
  const normalized = normalizedName.replace(/\\/g, '/').replace(/^\/+/, '');
  const details = format(normalized);
  if (!normalized.includes('/')) {
    if (isDataFile(normalized) && /^contextspace/i.test(normalized)) {
      return {
        editable: false,
        readOnlyReason: "ContextSpace's own store file cannot be edited directly.",
        managed: true,
      };
    }
    if (/^agents\.md$/i.test(normalized)) {
      return {
        editable: false,
        readOnlyReason: 'Generated by ContextSpace — refreshed automatically.',
        managed: true,
      };
    }
    if (/^(plan\.md|contextspace-milestones\.md)$/i.test(normalized)) {
      const switched = options?.switchedToDb ?? (readSwitch(root) !== null);
      if (switched) {
        return {
          editable: false,
          readOnlyReason: 'Managed on the Board database — edit steps on the Board.',
          managed: true,
        };
      }
    }
  }
  if (!details) {
    return { editable: false, readOnlyReason: "This file type can't be edited here." };
  }
  const isText = details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html';
  if (!isText) {
    return { editable: false, readOnlyReason: 'Only text, markdown, and HTML documents can be edited directly.' };
  }
  return { editable: true };
}

const pathQueues = new Map<string, { queue: ReturnType<typeof createMutationQueue>; count: number }>();

async function withDocumentPathLock<T>(targetPaths: string | readonly string[], run: () => Promise<T>): Promise<T> {
  const keys = Array.from(
    new Set((Array.isArray(targetPaths) ? targetPaths : [targetPaths]).map((p) => path.resolve(p))),
  ).sort();
  const acquireNext = (idx: number): Promise<T> => {
    if (idx >= keys.length) return run();
    const key = keys[idx]!;
    let entry = pathQueues.get(key);
    if (!entry) {
      entry = { queue: createMutationQueue(), count: 0 };
      pathQueues.set(key, entry);
    }
    entry.count += 1;
    return entry.queue(() => acquireNext(idx + 1)).finally(() => {
      entry!.count -= 1;
      if (entry!.count === 0 && pathQueues.get(key) === entry) {
        pathQueues.delete(key);
      }
    });
  };
  return acquireNext(0);
}

type ExistingConflictState =
  | { exists: false }
  | {
      exists: true;
      mode: number;
      currentRevision: string | null;
      currentContent?: string;
      currentModifiedAt: string;
    };

async function readExistingConflictState(
  root: string,
  target: string,
  normalizedName: string,
): Promise<ExistingConflictState> {
  let lstat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lstat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`Linked path components are not allowed in managed resource paths: ${target}`);
  }
  if (lstat.isDirectory()) {
    throw new Error(`Cannot save document: "${normalizedName}" is a directory.`);
  }
  if (!lstat.isFile()) {
    throw new Error(`Cannot save document: "${normalizedName}" is not a regular file.`);
  }
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await assertFileHandleMatchesPath(handle, target);
    await assertNoLinkedPathComponents(root, target);
    const modifiedAt = (await handle.stat()).mtime.toISOString();
    const mode = Number(stat.mode) & 0o7777;
    const details = format(normalizedName);
    const isText = Boolean(details && (details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html'));
    if (!isText || stat.size > BigInt(MAX_TEXT_BYTES)) {
      return {
        exists: true,
        mode,
        currentRevision: null,
        currentModifiedAt: modifiedAt,
      };
    }
    const existingBytes = await readFileHandleAtMost(handle, MAX_TEXT_BYTES + 1);
    await assertFileHandleMatchesPath(handle, target);
    if (existingBytes.length > MAX_TEXT_BYTES) {
      return {
        exists: true,
        mode,
        currentRevision: null,
        currentModifiedAt: modifiedAt,
      };
    }
    let currentContent: string;
    try {
      currentContent = new TextDecoder('utf-8', { fatal: true }).decode(existingBytes);
    } catch {
      currentContent = new TextDecoder('utf-8', { fatal: false }).decode(existingBytes);
    }
    return {
      exists: true,
      mode,
      currentRevision: sha256Hex(existingBytes),
      currentContent,
      currentModifiedAt: modifiedAt,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Runs a save or move of PLAN.md under the plan's own lock, so it cannot land between a move's check and its rename. */
async function withPlanLock<T>(root: string, names: string[], run: () => Promise<T>): Promise<T> {
  if (!names.some((name) => /^plan\.md$/i.test(name))) return run();
  const release = await acquireLock(path.join(root, '.contextspace', 'plan-file.lock'), { staleMs: 60_000, timeoutMs: 10_000, timeoutMessage: 'The plan is busy in another session. Retry.' });
  try { return await run(); } finally { await release(); }
}

export interface ListRootDocumentsOptions {
  /** Workspace-relative folders (with `/`) that hold a repository; the data files inside them are not listed. */
  repoFolders?: readonly string[];
  /** Workspace-relative folders (with `/`) that are not entered at all, so a listing that only wants the workspace's own documents skips a repository's files. */
  leaveOut?: readonly string[];
}

/** Agent-created files are local files, not copies registered with a storage adapter. */
export async function listRootDocuments(root: string, folder = '', recursive = false, options: ListRootDocumentsOptions = {}) {
  const repoFolders = (options.repoFolders ?? []).map((repoFolder) => repoFolder.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const inRepository = (rel: string) => repoFolders.some((repoFolder) => rel === repoFolder || rel.startsWith(`${repoFolder}/`));
  const leftOut = new Set((options.leaveOut ?? []).map((skipped) => skipped.replace(/^\/+|\/+$/g, '')).filter(Boolean));
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
          if (recursive && !leftOut.has(rel)) {
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
    const content = isText && !download ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined;
    const modifiedAt = (await handle.stat()).mtime.toISOString();
    return {
      name: normalizedName,
      ...details,
      size: Number(stat.size),
      modifiedAt,
      bytes,
      content,
      ...(isText && !download ? { revision: sha256Hex(bytes) } : {}),
    };
  } finally {
    await handle.close();
  }
}

export interface WriteRootDocumentOptions {
  expectedRevision?: string;
  createOnly?: boolean;
}

export async function writeRootDocument(
  root: string,
  name: string,
  content: string,
  options?: WriteRootDocumentOptions,
) {
  const normalizedName = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = documentPath(root, normalizedName, 'save');
  await assertNoLinkedPathComponents(root, target);
  const details = format(normalizedName);
  if (!details) {
    throw new Error(`${path.extname(normalizedName) || 'This'} files can't be saved here. Open it from the workspace folder instead.`);
  }
  const isText = details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html';
  if (!isText) {
    throw new Error('Only text, markdown, and HTML documents can be edited directly.');
  }
  if (options?.createOnly && options?.expectedRevision !== undefined) {
    throw new Error('Cannot combine createOnly and expectedRevision.');
  }
  if (options?.expectedRevision !== undefined && !/^[a-f0-9]{64}$/i.test(options.expectedRevision)) {
    throw new Error('Invalid expectedRevision.');
  }
  const bytes = Buffer.from(content, 'utf-8');
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new Error(`This document exceeds the ${MAX_TEXT_BYTES / 1024 / 1024} MB preview limit.`);
  }
  refuseStoreFile(root, normalizedName);

  const stat = await withDocumentPathLock(target, () =>
    withPlanLock(root, [normalizedName], async () => {
      await assertNoLinkedPathComponents(root, target);
      refuseStoreFile(root, normalizedName); // again under the lock, right before the write
      const existing = await readExistingConflictState(root, target, normalizedName);
      if (options?.createOnly && existing.exists) {
        throw new DocumentConflictError(`A document already exists at "${normalizedName}".`, {
          code: 'ALREADY_EXISTS',
          currentRevision: existing.currentRevision,
          currentContent: existing.currentContent,
          currentModifiedAt: existing.currentModifiedAt,
        });
      }
      if (options?.expectedRevision !== undefined) {
        const expected = options.expectedRevision.toLowerCase();
        if (!existing.exists) {
          throw new DocumentConflictError(`"${normalizedName}" was removed or moved on disk while you were editing.`, {
            code: 'CONFLICT',
            currentRevision: null,
            currentContent: '',
            currentModifiedAt: null,
          });
        }
        if (existing.currentRevision !== expected) {
          throw new DocumentConflictError(`"${normalizedName}" changed on disk while you were editing.`, {
            code: 'CONFLICT',
            currentRevision: existing.currentRevision,
            currentContent: existing.currentContent,
            currentModifiedAt: existing.currentModifiedAt,
          });
        }
      }
      const mode = existing.exists ? existing.mode : undefined;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await assertNoLinkedPathComponents(root, target);
      // A temp file, then a rename: a reader never sees half a document. The saved file keeps the old one's permission
      // bits (0600 stays 0600, an executable stays executable). It is a new file, so another hard link to the old one keeps
      // the old text. On Windows the bits are only the read-only flag, and a rename refused there falls back to copying
      // over the old file in place.
      await atomicWriteFile(target, bytes, undefined, { mode });
      return fs.stat(target);
    }),
  );

  return {
    name: normalizedName,
    ...details,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    revision: sha256Hex(bytes),
    content,
  };
}

export interface UploadRootDocumentOptions {
  createOnly?: boolean;
}

export async function uploadRootDocument(
  root: string,
  name: string,
  bytes: Uint8Array,
  options?: UploadRootDocumentOptions,
) {
  const createOnly = options?.createOnly ?? true;
  const normalizedName = checkedDocumentName(name, 'open').normalized;
  const target = documentPath(root, normalizedName, 'open');
  const details = format(normalizedName)!;
  const isText = details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html';
  const limit = isText ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
  if (bytes.byteLength > limit) {
    throw new Error(`This file exceeds the ${limit / 1024 / 1024} MB upload limit.`);
  }
  if (isText) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Text, markdown, and HTML files must be valid UTF-8.');
    }
  }
  await assertNoLinkedPathComponents(root, target);
  refuseStoreFile(root, normalizedName);

  const stat = await withDocumentPathLock(target, () =>
    withPlanLock(root, [normalizedName], async () => {
      await assertNoLinkedPathComponents(root, target);
      refuseStoreFile(root, normalizedName);
      const existing = await readExistingConflictState(root, target, normalizedName);
      if (createOnly && existing.exists) {
        throw new DocumentConflictError(`A document already exists at "${normalizedName}".`, {
          code: 'ALREADY_EXISTS',
          currentRevision: existing.currentRevision,
          currentContent: existing.currentContent,
          currentModifiedAt: existing.currentModifiedAt,
        });
      }
      const mode = existing.exists ? existing.mode : undefined;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await assertNoLinkedPathComponents(root, target);
      await atomicWriteFile(target, bytes, undefined, { mode });
      return fs.stat(target);
    }),
  );

  return {
    name: normalizedName,
    ...details,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    ...(isText ? { revision: sha256Hex(bytes) } : {}),
  };
}

export async function createRootFolder(root: string, folder: string) {
  const normalized = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new Error('Choose a folder inside this workspace.');
  const target = folderPath(root, normalized);
  await assertNoLinkedPathComponents(root, target);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) {
      throw new Error(`Cannot create folder: "${normalized}" is an existing file.`);
    }
    return { folder: normalized };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(target, { recursive: true });
  return { folder: normalized };
}

export async function moveRootDocument(root: string, from: string, to: string) {
  const fromNormalized = from.replace(/\\/g, '/').replace(/^\/+/, '');
  const toNormalized = to.replace(/\\/g, '/').replace(/^\/+/, '');
  const fromTarget = documentPath(root, fromNormalized);
  const toTarget = documentPath(root, toNormalized);
  await assertNoLinkedPathComponents(root, fromTarget);
  await assertNoLinkedPathComponents(root, toTarget);
  refuseStoreFile(root, fromNormalized);
  refuseStoreFile(root, toNormalized);
  if (fromNormalized === toNormalized) {
    await withDocumentPathLock(fromTarget, async () => {
      await assertNoLinkedPathComponents(root, fromTarget);
      try {
        const stat = await fs.lstat(fromTarget);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Document not found: "${fromNormalized}".`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Document not found: "${fromNormalized}".`);
        }
        throw error;
      }
    });
    return { from: fromNormalized, to: toNormalized };
  }
  await withDocumentPathLock([fromTarget, toTarget], () =>
    withPlanLock(root, [fromNormalized, toNormalized], async () => {
      await assertNoLinkedPathComponents(root, fromTarget);
      await assertNoLinkedPathComponents(root, toTarget);
      refuseStoreFile(root, fromNormalized);
      refuseStoreFile(root, toNormalized);
      try {
        const stat = await fs.lstat(fromTarget);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Document not found: "${fromNormalized}".`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Document not found: "${fromNormalized}".`);
        }
        throw error;
      }
      try {
        await fs.lstat(toTarget);
        throw new Error(`A file or folder already exists at "${toNormalized}".`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(toTarget), { recursive: true });
      await assertNoLinkedPathComponents(root, toTarget);
      await fs.rename(fromTarget, toTarget);
    }),
  );
  return { from: fromNormalized, to: toNormalized };
}

export interface PreviewRootDocumentOptions {
  metaOnly?: boolean;
}

export async function previewRootDocument(root: string, name: string, options?: PreviewRootDocumentOptions) {
  const normalizedName = openableDocumentName(name);
  const target = documentPath(root, normalizedName);
  await assertNoLinkedPathComponents(root, target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await assertFileHandleMatchesPath(handle, target);
    await assertNoLinkedPathComponents(root, target);
    const details = format(normalizedName)!;
    const isText = details.kind === 'markdown' || details.kind === 'text' || details.kind === 'html';
    const metaOnly = Boolean(options?.metaOnly) || !isText;
    const editability = documentEditability(root, normalizedName);

    if (metaOnly) {
      const modifiedAt = (await handle.stat()).mtime.toISOString();
      return {
        name: normalizedName,
        ...details,
        size: Number(stat.size),
        modifiedAt,
        content: undefined,
        editable: editability.editable,
        ...(editability.readOnlyReason ? { readOnlyReason: editability.readOnlyReason } : {}),
      };
    }

    if (stat.size > BigInt(MAX_TEXT_BYTES)) {
      throw new Error(`This document exceeds the ${MAX_TEXT_BYTES / 1024 / 1024} MB preview limit.`);
    }

    const bytes = await readFileHandleAtMost(handle, MAX_TEXT_BYTES + 1);
    await assertNoLinkedPathComponents(root, target);
    await assertFileHandleMatchesPath(handle, target);
    if (bytes.length > MAX_TEXT_BYTES) {
      throw new Error('The document grew beyond the size limit.');
    }

    const modifiedAt = (await handle.stat()).mtime.toISOString();
    return {
      name: normalizedName,
      ...details,
      size: Number(stat.size),
      modifiedAt,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      revision: sha256Hex(bytes),
      editable: editability.editable,
      ...(editability.readOnlyReason ? { readOnlyReason: editability.readOnlyReason } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function openRootDocumentForStream(root: string, name: string) {
  const normalizedName = openableDocumentName(name);
  const target = documentPath(root, normalizedName);
  await assertNoLinkedPathComponents(root, target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await assertFileHandleMatchesPath(handle, target);
    await assertNoLinkedPathComponents(root, target);
    const details = format(normalizedName)!;
    return {
      handle,
      name: normalizedName,
      ...details,
      size: Number(stat.size),
      modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
