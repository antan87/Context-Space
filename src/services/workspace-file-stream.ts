import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { assertFileHandleMatchesPath, assertNoLinkedPathComponents } from '../resources/fs-safety.js';
import { loadFeatureConfig } from '../core/workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';

/**
 * Case-insensitive extension allowlist for the read-only /view route.
 * Files outside this allowlist cannot be served over /view and result in 404.
 */
const VIEW_MIME_TYPES: Record<string, string> = {
  // HTML
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  // CSS
  '.css': 'text/css; charset=utf-8',
  // JS
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  // JSON
  '.json': 'application/json; charset=utf-8',
  // WebAssembly
  '.wasm': 'application/wasm',
  // SVG
  '.svg': 'image/svg+xml',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  // Fonts
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  // PDF
  '.pdf': 'application/pdf',
  // Media
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  // Plain text
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
};

export function viewMimeType(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  return ext ? (VIEW_MIME_TYPES[ext] ?? null) : null;
}

export const OPEN_HIDDEN_FOLDERS = new Set(['.claude', '.agents', '.github']);

export interface ViewTokenEntry {
  workspaceId: string;
  workspaceRoot: string;
  scopeFolder: string;
  excludedFolders: string[];
  createdAt: number;
}

export class ViewTokenStore {
  private readonly tokens = new Map<string, ViewTokenEntry>();
  private readonly maxTokens: number;
  private readonly ttlMs: number;

  constructor(options?: { maxTokens?: number; ttlMs?: number }) {
    this.maxTokens = options?.maxTokens ?? 2048;
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  issue(entry: Omit<ViewTokenEntry, 'createdAt'>): string {
    while (this.tokens.size >= this.maxTokens) {
      const oldestKey = this.tokens.keys().next().value;
      if (oldestKey !== undefined) {
        this.tokens.delete(oldestKey);
      } else {
        break;
      }
    }

    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, {
      ...entry,
      createdAt: Date.now(),
    });
    return token;
  }

  get(token: string): ViewTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  delete(token: string): void {
    this.tokens.delete(token);
  }

  clear(): void {
    this.tokens.clear();
  }

  size(): number {
    return this.tokens.size;
  }
}

export const defaultViewTokenStore = new ViewTokenStore();

export class ViewLinkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewLinkInputError';
  }
}

export class ViewNotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'ViewNotFoundError';
  }
}

export interface IssueWorkspaceViewLinkOptions {
  workspaceId: string;
  workspaceRoot: string;
  name: string;
  store?: ViewTokenStore;
}

export interface IssueWorkspaceViewLinkResult {
  token: string;
  url: string;
  scope: string;
}

export async function issueWorkspaceViewLink(options: IssueWorkspaceViewLinkOptions): Promise<IssueWorkspaceViewLinkResult> {
  if (!options.name || typeof options.name !== 'string') {
    throw new ViewLinkInputError('A document name is required.');
  }

  if (options.name.startsWith('/') || options.name.includes('\\') || /[:\x00-\x1f\x7f]/.test(options.name)) {
    throw new ViewLinkInputError('Choose a valid document path inside this workspace.');
  }

  const segments = options.name.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new ViewLinkInputError('Choose a valid document path inside this workspace.');
  }

  if (segments[0]!.startsWith('.')) {
    if (!OPEN_HIDDEN_FOLDERS.has(segments[0]!)) {
      throw new ViewLinkInputError('Hidden files and folders cannot be viewed, except .claude, .agents, and .github.');
    }
  }

  for (let i = 1; i < segments.length; i++) {
    if (segments[i]!.startsWith('.')) {
      throw new ViewLinkInputError('Hidden segments are not allowed.');
    }
  }

  const fileName = segments[segments.length - 1]!;
  const mime = viewMimeType(fileName);
  if (!mime) {
    throw new ViewLinkInputError('Files with this extension cannot be viewed.');
  }

  const resolvedRoot = path.resolve(options.workspaceRoot);
  const feature = await loadFeatureConfig(resolvedRoot);
  const excludedFolders: string[] = [];
  if (feature?.repos) {
    for (const repoPath of feature.repos) {
      const resolved = resolveFeatureRepoPath(feature, resolvedRoot, repoPath);
      const relative = path.relative(resolvedRoot, resolved);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const normalized = relative.split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
        if (normalized) {
          excludedFolders.push(normalized);
        }
      }
    }
  }

  const rel = segments.join('/');
  for (const repoFolder of excludedFolders) {
    if (rel === repoFolder || rel.startsWith(`${repoFolder}/`)) {
      throw new ViewLinkInputError('Cannot view files inside repository checkouts.');
    }
  }

  const opened = await openScopedViewFile(resolvedRoot, segments);
  try {
    // verified regular file, closed immediately
  } finally {
    await opened.handle.close().catch(() => {});
  }

  const scopeFolder = segments.length > 1 ? segments[0]! : '';
  const store = options.store ?? defaultViewTokenStore;
  const token = store.issue({
    workspaceId: options.workspaceId,
    workspaceRoot: resolvedRoot,
    scopeFolder,
    excludedFolders,
  });

  const url = `/view/${token}/${segments.map(encodeURIComponent).join('/')}`;
  return {
    token,
    url,
    scope: scopeFolder || '.',
  };
}

export interface ParsedViewPath {
  token: string;
  segments: string[];
}

export function parseViewRequestPath(rawRequestTarget: string): ParsedViewPath | null {
  const pathOnly = rawRequestTarget.split(/[?#]/)[0]!;
  if (!pathOnly.startsWith('/view/')) return null;

  const remainder = pathOnly.slice('/view/'.length);
  if (remainder.includes('\\') || /%2f/i.test(remainder) || /%5c/i.test(remainder) || /%00/i.test(remainder)) {
    return null;
  }

  const parts = remainder.split('/');
  if (parts.length < 2) return null;

  const token = parts[0]!;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return null;
  }

  const rawSegments = parts.slice(1);
  if (rawSegments.length < 1) return null;
  if (rawSegments.some((seg) => seg === '')) return null;

  const segments: string[] = [];
  for (const rawSeg of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      return null;
    }
    if (!decoded || decoded === '.' || decoded === '..') {
      return null;
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes(':') || /[\x00-\x1f\x7f]/.test(decoded)) {
      return null;
    }
    segments.push(decoded);
  }

  return { token, segments };
}

export function isSegmentsAllowedInScope(segments: string[], entry: ViewTokenEntry): boolean {
  if (segments.length === 0) return false;

  const rel = segments.join('/');
  for (const repoFolder of entry.excludedFolders) {
    const normalizedRepo = repoFolder.replace(/^\/+|\/+$/g, '');
    if (!normalizedRepo) continue;
    if (rel === normalizedRepo || rel.startsWith(`${normalizedRepo}/`)) {
      return false;
    }
  }

  if (entry.scopeFolder !== '') {
    if (segments[0] !== entry.scopeFolder || segments.length < 2) {
      return false;
    }
    for (let i = 1; i < segments.length; i++) {
      if (segments[i]!.startsWith('.')) {
        return false;
      }
    }
    return true;
  }

  for (const seg of segments) {
    if (seg.startsWith('.')) {
      return false;
    }
  }

  return true;
}

export interface OpenScopedFileResult {
  handle: fs.FileHandle;
  size: number;
  mtimeNs: bigint;
  mtimeMs: number;
}

export async function openScopedViewFile(workspaceRoot: string, segments: string[]): Promise<OpenScopedFileResult> {
  const targetPath = path.join(workspaceRoot, ...segments);
  let handle: fs.FileHandle | undefined;
  try {
    await assertNoLinkedPathComponents(workspaceRoot, targetPath);
    handle = await fs.open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await assertFileHandleMatchesPath(handle, targetPath);
    await assertNoLinkedPathComponents(workspaceRoot, targetPath);
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || stat.size < 0n) {
      throw new ViewNotFoundError('Not found.');
    }
    return {
      handle,
      size,
      mtimeNs: stat.mtimeNs,
      mtimeMs: Number(stat.mtimeMs),
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (error instanceof ViewNotFoundError) {
      throw error;
    }
    throw new ViewNotFoundError('Not found.');
  }
}

export function computeFileEtag(size: number, mtimeNs: bigint): string {
  return `"${size.toString(16)}-${mtimeNs.toString(16)}"`;
}

export function matchesIfNoneMatch(headerValue: string | undefined, etag: string): boolean {
  if (!headerValue) return false;
  const targetEtag = etag.replace(/^W\//, '').trim();
  const candidates = headerValue.split(',').map((s) => s.trim());
  for (const candidate of candidates) {
    if (candidate === '*') return true;
    const stripped = candidate.replace(/^W\//, '').trim();
    if (stripped === targetEtag) return true;
  }
  return false;
}

export type ParseRangeResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function parseSingleByteRange(rangeHeader: string, size: number): ParseRangeResult {
  if (size <= 0) return { kind: 'unsatisfiable' };
  if (!rangeHeader.startsWith('bytes=')) return { kind: 'unsatisfiable' };
  if (rangeHeader.includes(',')) return { kind: 'unsatisfiable' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return { kind: 'unsatisfiable' };

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return { kind: 'unsatisfiable' };

  if (!startStr) {
    const suffix = parseInt(endStr!, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    const end = size - 1;
    return { kind: 'ok', start, end };
  }

  const start = parseInt(startStr, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: 'unsatisfiable' };

  if (!endStr) {
    return { kind: 'ok', start, end: size - 1 };
  }

  const end = parseInt(endStr, 10);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'ok', start, end: Math.min(end, size - 1) };
}

export function createFileByteStream(
  handle: fs.FileHandle,
  start: number,
  end: number,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  if (end < start) {
    void handle.close().catch(() => {});
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }

  const CHUNK_SIZE = 64 * 1024;
  let position = start;
  let remaining = end - start + 1;
  let closed = false;

  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    await handle.close().catch(() => {});
  };

  const onAbort = () => {
    void closeHandle();
  };

  if (signal) {
    if (signal.aborted) {
      void closeHandle();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0 || signal?.aborted) {
        await closeHandle();
        controller.close();
        return;
      }

      const toRead = Math.min(CHUNK_SIZE, remaining);
      const buf = Buffer.allocUnsafe(toRead);

      try {
        const { bytesRead } = await handle.read(buf, 0, toRead, position);
        if (bytesRead === 0) {
          await closeHandle();
          controller.close();
          return;
        }

        position += bytesRead;
        remaining -= bytesRead;

        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));

        if (remaining <= 0) {
          await closeHandle();
          controller.close();
        }
      } catch (error) {
        await closeHandle();
        controller.error(new Error('Stream read failed.'));
      }
    },
    async cancel() {
      await closeHandle();
    },
  });
}
