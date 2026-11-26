import { ApiError, apiFetch } from '../../lib/api/client.js';
import { API_BASE } from '../../lib/apiBase.js';
import { normalizeCatalogPath, type DocumentCatalogItem, type DocumentCatalogKind } from './documentsCatalog.js';

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const EDITABLE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.csv',
  '.tsv',
  '.log',
  '.mmd',
  '.html',
  '.htm',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
]);

export const DATA_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.xml']);

export const UPLOAD_EXTENSIONS = new Set([
  ...EDITABLE_EXTENSIONS,
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
]);

const OPEN_HIDDEN_FOLDERS = new Set(['.claude', '.agents', '.github']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.contextspace', '.vscode', '.idea']);

export type DocumentConflictCode = 'CONFLICT' | 'ALREADY_EXISTS';

export interface DocumentConflictDetails {
  code: DocumentConflictCode;
  currentRevision: string | null;
  currentContent?: string;
  currentModifiedAt?: string | null;
}

export class DocumentConflictError extends Error {
  readonly status = 409;
  readonly code: DocumentConflictCode;
  readonly currentRevision: string | null;
  readonly currentContent?: string;
  readonly currentModifiedAt?: string | null;

  constructor(message: string, details: DocumentConflictDetails) {
    super(message);
    this.name = 'DocumentConflictError';
    this.code = details.code;
    this.currentRevision = details.currentRevision;
    this.currentContent = details.currentContent;
    this.currentModifiedAt = details.currentModifiedAt;
  }
}

export interface DocumentSaveResult {
  name: string;
  kind: DocumentCatalogKind;
  mime: string;
  size: number;
  modifiedAt: string;
  revision: string;
  content: string;
}

export interface DocumentUploadResult {
  name: string;
  kind: DocumentCatalogKind;
  mime: string;
  size: number;
  modifiedAt: string;
  revision?: string;
}

export interface DocumentFolderResult {
  folder: string;
}

export interface DocumentMoveResult {
  from: string;
  to: string;
}

export function isManagedReadOnlyItem(
  item: Pick<DocumentCatalogItem, 'path' | 'kind' | 'editable'>,
): boolean {
  if (item.editable) return false;
  if (item.path.toLowerCase() === 'agents.md') return true;
  return item.kind === 'markdown' || item.kind === 'text' || item.kind === 'html';
}

export function parseDocumentConflict(error: unknown): DocumentConflictDetails | null {
  if (error instanceof DocumentConflictError) {
    return {
      code: error.code,
      currentRevision: error.currentRevision,
      currentContent: error.currentContent,
      currentModifiedAt: error.currentModifiedAt,
    };
  }
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const code = record.code === 'ALREADY_EXISTS' ? 'ALREADY_EXISTS' : record.code === 'CONFLICT' ? 'CONFLICT' : null;
  if (!code) return null;
  const currentRevision = typeof record.currentRevision === 'string' ? record.currentRevision : null;
  const currentContent = typeof record.currentContent === 'string' ? record.currentContent : undefined;
  const currentModifiedAt =
    typeof record.currentModifiedAt === 'string'
      ? record.currentModifiedAt
      : record.currentModifiedAt === null
        ? null
        : undefined;
  return { code, currentRevision, currentContent, currentModifiedAt };
}

function validateFolderSegments(segments: string[]): string | null {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      return 'Choose a folder inside this workspace.';
    }
    if (IGNORED_DIRECTORIES.has(segment)) {
      return `Cannot use "${segment}" here.`;
    }
    if (segment.startsWith('.') && !OPEN_HIDDEN_FOLDERS.has(segment)) {
      return 'Hidden folders starting with "." cannot be used here (except .claude, .agents, .github).';
    }
  }
  return null;
}

function hasInvalidPathChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === ':' || code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export type ResolvedNewDocumentPath =
  | { ok: true; path: string; folder: string; fileName: string; autoAppendedMd: boolean }
  | { ok: false; error: string };

export function resolveNewDocumentPath(folder: string, rawName: string): ResolvedNewDocumentPath {
  const cleanFolder = normalizeCatalogPath(folder);
  if (cleanFolder) {
    if (hasInvalidPathChars(cleanFolder)) {
      return { ok: false, error: 'Choose a folder inside this workspace.' };
    }
    const folderErr = validateFolderSegments(cleanFolder.split('/'));
    if (folderErr) return { ok: false, error: folderErr };
  }

  const trimmedName = rawName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmedName) {
    return { ok: false, error: 'Enter a file name.' };
  }
  if (trimmedName.endsWith('/')) {
    return { ok: false, error: 'Enter a file name, not a folder path.' };
  }
  if (hasInvalidPathChars(trimmedName)) {
    return { ok: false, error: 'Choose a document inside this workspace.' };
  }

  const nameSegments = trimmedName.split('/');
  if (nameSegments.some((s) => !s || s === '.' || s === '..')) {
    return { ok: false, error: 'Choose a document inside this workspace.' };
  }

  const parentSegs = nameSegments.slice(0, -1);
  const parentErr = validateFolderSegments(parentSegs);
  if (parentErr) return { ok: false, error: parentErr };

  const rawFile = nameSegments[nameSegments.length - 1]!;
  if (rawFile.startsWith('.')) {
    return { ok: false, error: 'Hidden files starting with "." cannot be added here.' };
  }

  const dot = rawFile.lastIndexOf('.');
  if (dot === rawFile.length - 1) {
    return { ok: false, error: 'Enter a valid file name and extension.' };
  }

  let finalFile = rawFile;
  let autoAppendedMd = false;
  if (dot < 0) {
    finalFile = `${rawFile}.md`;
    autoAppendedMd = true;
  } else {
    const ext = rawFile.slice(dot).toLowerCase();
    if (!EDITABLE_EXTENSIONS.has(ext)) {
      if (UPLOAD_EXTENSIONS.has(ext)) {
        return { ok: false, error: `${ext} files are added via Upload, not created in the text editor.` };
      }
      return { ok: false, error: `${ext} files cannot be created here. Use .md, .txt, .html, .json, .yaml, or .mmd.` };
    }
  }

  const relSegments = [...parentSegs, finalFile];
  const fullPath = cleanFolder ? `${cleanFolder}/${relSegments.join('/')}` : relSegments.join('/');

  if (!fullPath.includes('/')) {
    const ext = fullPath.slice(fullPath.lastIndexOf('.')).toLowerCase();
    if (DATA_EXTENSIONS.has(ext) && /^contextspace/i.test(fullPath)) {
      return { ok: false, error: `${fullPath} is reserved for ContextSpace internal state.` };
    }
    if (/^agents\.md$/i.test(fullPath)) {
      return { ok: false, error: 'AGENTS.md at workspace root is generated automatically by ContextSpace.' };
    }
  }

  const slash = fullPath.lastIndexOf('/');
  return {
    ok: true,
    path: fullPath,
    folder: slash < 0 ? '' : fullPath.slice(0, slash),
    fileName: slash < 0 ? fullPath : fullPath.slice(slash + 1),
    autoAppendedMd,
  };
}

export type ResolvedNewFolderPath =
  | { ok: true; folder: string }
  | { ok: false; error: string };

export function resolveNewFolderPath(parentFolder: string, rawFolder: string): ResolvedNewFolderPath {
  const cleanParent = normalizeCatalogPath(parentFolder);
  const cleanChild = normalizeCatalogPath(rawFolder);
  if (!cleanChild) {
    return { ok: false, error: 'Enter a folder name.' };
  }
  const combined = cleanParent ? `${cleanParent}/${cleanChild}` : cleanChild;
  if (hasInvalidPathChars(combined)) {
    return { ok: false, error: 'Choose a folder inside this workspace.' };
  }
  const folderErr = validateFolderSegments(combined.split('/'));
  if (folderErr) return { ok: false, error: folderErr };
  return { ok: true, folder: combined };
}

function splitStemAndExt(filePath: string): { prefix: string; stem: string; ext: string } {
  const normalized = normalizeCatalogPath(filePath);
  const slash = normalized.lastIndexOf('/');
  const prefix = slash < 0 ? '' : normalized.slice(0, slash + 1);
  const base = slash < 0 ? normalized : normalized.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return { prefix, stem: base, ext: '' };
  }
  return { prefix, stem: base.slice(0, dot), ext: base.slice(dot) };
}

export function suggestCopyPath(originalPath: string, existingPaths?: ReadonlySet<string>): string {
  const { prefix, stem, ext } = splitStemAndExt(originalPath);
  const first = `${prefix}${stem}-copy${ext}`;
  if (!existingPaths || !existingPaths.has(first)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${prefix}${stem}-copy-${i}${ext}`;
    if (!existingPaths.has(candidate)) return candidate;
  }
  return `${prefix}${stem}-copy-${Date.now()}${ext}`;
}

export function suggestNumberedPath(originalPath: string, existingPaths?: ReadonlySet<string>): string {
  const { prefix, stem, ext } = splitStemAndExt(originalPath);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${prefix}${stem}-${i}${ext}`;
    if (!existingPaths || !existingPaths.has(candidate)) return candidate;
  }
  return `${prefix}${stem}-${Date.now()}${ext}`;
}

export function validateUploadFile(
  file: Pick<File, 'name' | 'size'>,
): { ok: true; fileName: string } | { ok: false; error: string } {
  const normalized = (file.name ?? '').replace(/\\/g, '/');
  const fileName = normalized.split('/').pop()?.trim() ?? '';
  if (!fileName || fileName === '.' || fileName === '..' || hasInvalidPathChars(fileName)) {
    return { ok: false, error: 'Unsupported file name.' };
  }
  if (fileName.startsWith('.')) {
    return { ok: false, error: `${fileName}: hidden dotfiles cannot be uploaded here.` };
  }
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
  if (!ext || !UPLOAD_EXTENSIONS.has(ext)) {
    return { ok: false, error: `${fileName}: ${ext || 'this'} file type cannot be uploaded here.` };
  }
  const isText = EDITABLE_EXTENSIONS.has(ext);
  const limit = isText ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) {
    return {
      ok: false,
      error: `${fileName}: exceeds the ${isText ? '1 MB text' : '25 MB file'} upload limit.`,
    };
  }
  return { ok: true, fileName };
}

function toConflictOrThrow(error: unknown, fallbackMessage: string): never {
  if (error instanceof ApiError && error.status === 409) {
    const details = parseDocumentConflict(error);
    if (details) {
      throw new DocumentConflictError(error.message || fallbackMessage, details);
    }
  }
  throw error;
}

export async function saveDocument(
  workspaceId: string,
  params: {
    name: string;
    content: string;
    expectedRevision?: string;
    createOnly?: boolean;
  },
): Promise<DocumentSaveResult> {
  try {
    return await apiFetch<DocumentSaveResult>(
      `/api/workspace/${encodeURIComponent(workspaceId)}/documents`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: params.name,
          content: params.content,
          ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {}),
          ...(params.createOnly !== undefined ? { createOnly: params.createOnly } : {}),
        }),
      },
    );
  } catch (error) {
    return toConflictOrThrow(error, `Conflict saving "${params.name}".`);
  }
}

export async function createFolder(workspaceId: string, folder: string): Promise<DocumentFolderResult> {
  return apiFetch<DocumentFolderResult>(
    `/api/workspace/${encodeURIComponent(workspaceId)}/documents/folders`,
    {
      method: 'POST',
      body: JSON.stringify({ folder }),
    },
  );
}

export async function moveDocument(workspaceId: string, from: string, to: string): Promise<DocumentMoveResult> {
  return apiFetch<DocumentMoveResult>(
    `/api/workspace/${encodeURIComponent(workspaceId)}/documents/move`,
    {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    },
  );
}

export async function uploadDocument(
  workspaceId: string,
  params: {
    file: File;
    folder?: string;
    name?: string;
    createOnly?: boolean;
  },
): Promise<DocumentUploadResult> {
  const formData = new FormData();
  formData.append('file', params.file);
  if (params.folder) formData.append('folder', params.folder);
  if (params.name) formData.append('name', params.name);
  if (params.createOnly !== undefined) formData.append('createOnly', params.createOnly ? '1' : '0');

  const res = await fetch(`${API_BASE}/api/workspace/${encodeURIComponent(workspaceId)}/documents/upload`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  const message =
    (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' && (data as { error: string }).error)
    || `Upload failed (${res.status})`;

  if (!res.ok) {
    const apiErr = new ApiError(message, res.status, data);
    if (res.status === 409) {
      return toConflictOrThrow(apiErr, message);
    }
    throw apiErr;
  }

  return data as DocumentUploadResult;
}

export interface SideDocumentDraftState {
  path: string;
  folder: string;
  content: string;
  baseContent: string;
  baseRevision?: string;
  baseModifiedAt?: string;
  baseCatalogModifiedAt?: string;
  conflict: DocumentConflictDetails | null;
  saveError: string | null;
  dirty: boolean;
}

export interface ReaderDocumentDraftState {
  editing: boolean;
  dirty: boolean;
  draft: string;
  baseContent: string;
  baseRevision?: string;
  baseModifiedAt?: string;
}

export interface WorkspaceDocumentDraftSnapshot {
  folder: string;
  sideDraft: SideDocumentDraftState | null;
  readerPath: string | null;
  readerDrafts: Record<string, ReaderDocumentDraftState>;
}

const workspaceDraftStore = new Map<string, WorkspaceDocumentDraftSnapshot>();

function cloneReaderDrafts(
  drafts: Record<string, ReaderDocumentDraftState>,
): Record<string, ReaderDocumentDraftState> {
  const out: Record<string, ReaderDocumentDraftState> = {};
  for (const [docPath, entry] of Object.entries(drafts)) {
    if (!entry.editing && !entry.dirty) continue;
    out[docPath] = { ...entry };
  }
  return out;
}

function cloneSideDraft(sideDraft: SideDocumentDraftState | null): SideDocumentDraftState | null {
  if (!sideDraft) return null;
  return {
    ...sideDraft,
    conflict: sideDraft.conflict ? { ...sideDraft.conflict } : null,
  };
}

export function getWorkspaceDocumentDrafts(workspaceId: string): WorkspaceDocumentDraftSnapshot | null {
  if (!workspaceId) return null;
  const entry = workspaceDraftStore.get(workspaceId);
  if (!entry) return null;
  const readerDrafts = cloneReaderDrafts(entry.readerDrafts);
  const sideDraft = cloneSideDraft(entry.sideDraft);
  const readerPath = entry.readerPath && readerDrafts[entry.readerPath] ? entry.readerPath : null;
  if (!sideDraft && Object.keys(readerDrafts).length === 0) return null;
  return {
    folder: entry.folder,
    sideDraft,
    readerPath,
    readerDrafts,
  };
}

export function setWorkspaceDocumentDrafts(
  workspaceId: string,
  snapshot: WorkspaceDocumentDraftSnapshot,
): void {
  if (!workspaceId) return;
  const sideDraft = cloneSideDraft(snapshot.sideDraft);
  const readerDrafts = cloneReaderDrafts(snapshot.readerDrafts);
  const hasReaderDrafts = Object.keys(readerDrafts).length > 0;
  if (!sideDraft && !hasReaderDrafts) {
    workspaceDraftStore.delete(workspaceId);
    return;
  }
  const readerPath =
    snapshot.readerPath && readerDrafts[snapshot.readerPath]
      ? snapshot.readerPath
      : null;
  workspaceDraftStore.set(workspaceId, {
    folder: snapshot.folder,
    sideDraft,
    readerPath,
    readerDrafts,
  });
}

export function clearDocumentDraftStore(workspaceId?: string): void {
  if (workspaceId !== undefined) {
    workspaceDraftStore.delete(workspaceId);
    return;
  }
  workspaceDraftStore.clear();
}
