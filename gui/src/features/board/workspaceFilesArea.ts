import { agoText } from '../plan/whatsNew.js';
import type { AreaData, AreaPicture, BoardArea } from './boardAreas.js';
import type { BoardCard, WorkspaceFileEntry } from './boardData.js';
import { imageAlt, type FileType, type LaneCard } from './boardLayout.js';

export const FILES_AREA_ID = 'files:workspace';

export const WORKSPACE_FILE_ROW_IDS = {
  documents: 'row:ws:documents',
  pages: 'row:ws:pages',
  pictures: 'row:ws:pictures',
} as const;

export type WorkspaceFileGroup = 'documents' | 'pages' | 'pictures';

export interface GroupedWorkspaceFile {
  path: string;
  name: string;
  folder: string;
  modifiedAt: string;
  size: number;
  group: WorkspaceFileGroup;
  fileType: FileType;
}

export interface GroupedWorkspaceFiles {
  documents: GroupedWorkspaceFile[];
  pages: GroupedWorkspaceFile[];
  pictures: GroupedWorkspaceFile[];
  total: number;
}

const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.pdf']);
const PAGE_EXTENSIONS = new Set(['.html', '.htm']);
const PICTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export function normalizeWorkspaceFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

export function workspaceFileNodeId(filePath: string): string {
  return `wsfile:${normalizeWorkspaceFilePath(filePath)}`;
}

export function stepWorkspaceFileNodeId(stepKey: string, filePath: string): string {
  return `wsfile:step:${stepKey}:${normalizeWorkspaceFilePath(filePath)}`;
}

export function isWorkspaceFileNodeId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('wsfile:');
}

/**
 * Excludes generated and ContextSpace control files using the same rule as `src/core/whats-new.ts`
 * (`AGENTS.md`, `CLAUDE.md`, `WORKSPACE.md`, `contextspace-*`, `nexusflow-*`, `.agents/`, `.claude/`,
 * `.contextspace/`, and `.github/` instructions), while explicitly keeping `PLAN.md` in.
 */
export function isOwnGeneratedFile(filePath: string): boolean {
  const normalized = normalizeWorkspaceFilePath(filePath);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (lower === 'plan.md') return false;
  if (!lower.includes('/')) {
    return ['agents.md', 'claude.md', 'workspace.md'].includes(lower) || /^(contextspace|nexusflow)[-.]/.test(lower);
  }
  return /^\.(claude|agents|contextspace)\//.test(lower) || lower === '.github/copilot-instructions.md' || /^\.github\/instructions\//.test(lower);
}

/** Classifies a workspace file path into Documents, Pages, or Pictures (including `.svg`), or null when omitted. */
export function classifyWorkspaceFile(filePath: string): WorkspaceFileGroup | null {
  const normalized = normalizeWorkspaceFilePath(filePath);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'documents';
  if (PAGE_EXTENSIONS.has(ext)) return 'pages';
  if (PICTURE_EXTENSIONS.has(ext)) return 'pictures';
  return null;
}

function fileTypeForWorkspaceGroup(filePath: string, group: WorkspaceFileGroup): FileType {
  if (group === 'pictures') return 'image';
  if (group === 'pages') return 'html';
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.md') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  return 'other';
}

function splitFilePath(filePath: string): { name: string; folder: string } {
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return { name: filePath, folder: '' };
  return { name: filePath.slice(slash + 1), folder: filePath.slice(0, slash) };
}

function sortNewestFirst(a: GroupedWorkspaceFile, b: GroupedWorkspaceFile): number {
  const aMs = a.modifiedAt ? Date.parse(a.modifiedAt) : NaN;
  const bMs = b.modifiedAt ? Date.parse(b.modifiedAt) : NaN;
  const aTime = Number.isFinite(aMs) ? aMs : 0;
  const bTime = Number.isFinite(bMs) ? bMs : 0;
  if (bTime !== aTime) return bTime - aTime;
  return a.path.localeCompare(b.path);
}

/** Returns true only for the workspace root plan file (`PLAN.md` after path normalization). */
function isWorkspacePlanFile(filePath: string): boolean {
  return normalizeWorkspaceFilePath(filePath).toLowerCase() === 'plan.md';
}

/** Keeps PLAN.md always first in Documents, then orders remaining documents newest-first. */
function sortDocumentsPlanFirst(a: GroupedWorkspaceFile, b: GroupedWorkspaceFile): number {
  const aPlan = isWorkspacePlanFile(a.path);
  const bPlan = isWorkspacePlanFile(b.path);
  if (aPlan !== bPlan) return aPlan ? -1 : 1;
  return sortNewestFirst(a, b);
}

/** Converts one workspace listing entry into a classified file item, or returns null when excluded/unclassified. */
export function toGroupedWorkspaceFile(entry: WorkspaceFileEntry): GroupedWorkspaceFile | null {
  const normalized = normalizeWorkspaceFilePath(entry.path);
  if (!normalized || isOwnGeneratedFile(normalized)) return null;
  const group = classifyWorkspaceFile(normalized);
  if (!group) return null;

  const { name, folder } = splitFilePath(normalized);
  return {
    path: normalized,
    name,
    folder,
    modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : '',
    size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
    group,
    fileType: fileTypeForWorkspaceGroup(normalized, group),
  };
}

/** Builds a normalized-path lookup of all qualifying workspace files (preserving listing order on collisions). */
export function buildQualifyingWorkspaceFileMap(
  files: readonly WorkspaceFileEntry[] | undefined,
): Map<string, GroupedWorkspaceFile> {
  const byPath = new Map<string, GroupedWorkspaceFile>();
  if (!files || files.length === 0) return byPath;
  for (const entry of files) {
    const item = toGroupedWorkspaceFile(entry);
    if (!item || byPath.has(item.path)) continue;
    byPath.set(item.path, item);
  }
  return byPath;
}

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function stripTokenDelimiters(raw: string): string {
  return raw.replace(/^[\s("'[{<`]+/, '').replace(/[\s)"'\]}>.,:;!?`]+$/, '');
}

/**
 * Extracts qualifying workspace files whose exact normalized relative path appears in `stepText`
 * (either inside backticks, markdown link targets, or plain tokens), preserving order of first appearance.
 */
export function extractStepFilePaths(
  stepText: string,
  qualifyingFiles: ReadonlyMap<string, GroupedWorkspaceFile>,
): GroupedWorkspaceFile[] {
  if (!stepText || qualifyingFiles.size === 0) return [];
  const found: GroupedWorkspaceFile[] = [];
  const seen = new Set<string>();

  const tryCandidate = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed || URL_SCHEME_RE.test(trimmed)) return false;
    const direct = normalizeWorkspaceFilePath(trimmed);
    const cleaned = normalizeWorkspaceFilePath(stripTokenDelimiters(trimmed));
    const match = qualifyingFiles.get(direct) ?? qualifyingFiles.get(cleaned);
    if (!match || isWorkspacePlanFile(match.path)) return false;
    if (!seen.has(match.path)) {
      seen.add(match.path);
      found.push(match);
    }
    return true;
  };

  const scanPlain = (text: string): void => {
    for (const part of text.split(/\s+/)) {
      if (!part) continue;
      if (tryCandidate(part)) continue;
      if (part.includes(',')) {
        for (const piece of part.split(',')) {
          if (piece) tryCandidate(piece);
        }
      }
    }
  };

  const tokenRe = /`([^`]+)`|\[[^\]]*\]\(([^)]+)\)|(\S+)/g;
  for (const match of stepText.matchAll(tokenRe)) {
    if (match[1] !== undefined) {
      if (!tryCandidate(match[1])) scanPlain(match[1]);
    } else if (match[2] !== undefined) {
      if (!tryCandidate(match[2])) scanPlain(match[2]);
    } else if (match[3] !== undefined) {
      scanPlain(match[3]);
    }
  }
  return found;
}

/** Converts a classified workspace file into a read-only compact LaneCard item. */
export function workspaceFileToLaneCard(
  file: GroupedWorkspaceFile,
  options: { id: string; height: number; nowDate: Date },
): LaneCard {
  return {
    id: options.id,
    type: 'file',
    height: options.height,
    data: {
      title: file.name,
      path: file.path,
      fileType: file.fileType,
      group: file.group,
      by: 'workspace',
      at: file.modifiedAt,
      updatedAt: file.modifiedAt,
      text: file.folder || 'Workspace root',
      folder: file.folder,
      age: file.modifiedAt ? agoText(file.modifiedAt, options.nowDate) : '',
      readOnly: true,
      compact: true,
      pinned: false,
      archived: false,
      updatedBy: 'workspace',
      fresh: false,
    },
  };
}

/**
 * Pure transformation turning a flat workspace listing into ordered Documents, Pages, and Pictures groups
 * while dropping generated ContextSpace files, paths already present as real file cards on the board,
 * and any extra excluded paths (e.g. files placed on plan steps or assigned Area documents in WF2).
 */
export function groupWorkspaceFiles(
  files: readonly WorkspaceFileEntry[] | undefined,
  options: {
    existingCards?: readonly BoardCard[];
    excludePaths?: Iterable<string>;
  } = {},
): GroupedWorkspaceFiles {
  if (!files || files.length === 0) {
    return { documents: [], pages: [], pictures: [], total: 0 };
  }

  const excluded = new Set<string>();
  for (const card of options.existingCards ?? []) {
    if (card.kind === 'file' && !card.archived && card.path) {
      excluded.add(normalizeWorkspaceFilePath(card.path));
    }
  }
  if (options.excludePaths) {
    for (const rawPath of options.excludePaths) {
      const normalized = normalizeWorkspaceFilePath(rawPath);
      if (normalized) excluded.add(normalized);
    }
  }

  const documents: GroupedWorkspaceFile[] = [];
  const pages: GroupedWorkspaceFile[] = [];
  const pictures: GroupedWorkspaceFile[] = [];
  const seen = new Set<string>();

  for (const entry of files) {
    const item = toGroupedWorkspaceFile(entry);
    if (!item || seen.has(item.path) || excluded.has(item.path)) continue;
    seen.add(item.path);

    if (item.group === 'documents') documents.push(item);
    else if (item.group === 'pages') pages.push(item);
    else pictures.push(item);
  }

  documents.sort(sortDocumentsPlanFirst);
  pages.sort(sortNewestFirst);
  pictures.sort(sortNewestFirst);

  return {
    documents,
    pages,
    pictures,
    total: documents.length + pages.length + pictures.length,
  };
}

/** Formats `"N documents · N pages · N pictures"` (or compact `"N docs · N pages · N pictures"`) omitting kinds with 0 items. */
export function formatWorkspaceFileCounts(
  data: Pick<AreaData, 'documentCount' | 'pageCount' | 'pictureCount'>,
  options: { compact?: boolean } = {},
): string[] {
  const parts: string[] = [];
  const docs = data.documentCount ?? 0;
  const pages = data.pageCount ?? 0;
  const pics = data.pictureCount ?? 0;
  const docSingular = options.compact ? 'doc' : 'document';
  const docPlural = options.compact ? 'docs' : 'documents';
  if (docs > 0) parts.push(docs === 1 ? `1 ${docSingular}` : `${docs} ${docPlural}`);
  if (pages > 0) parts.push(pages === 1 ? '1 page' : `${pages} pages`);
  if (pics > 0) parts.push(pics === 1 ? '1 picture' : `${pics} pictures`);
  return parts;
}

/** Builds the "Workspace files" Area when at least one qualifying workspace file exists. */
export function buildWorkspaceFilesArea(
  files: readonly WorkspaceFileEntry[] | undefined,
  options: {
    existingCards?: readonly BoardCard[];
    excludePaths?: Iterable<string>;
    now?: number;
  } = {},
): BoardArea | null {
  const grouped = groupWorkspaceFiles(files, options);
  if (grouped.total === 0) return null;

  const pictures: AreaPicture[] = grouped.pictures.slice(0, 3).map((pic) => ({
    path: pic.path,
    alt: imageAlt({ title: pic.name, description: pic.folder, path: pic.path }),
  }));

  const previewSource = grouped.documents[0] ?? grouped.pages[0];
  const nowDate = options.now !== undefined ? new Date(options.now) : new Date();
  const preview = pictures.length === 0 && previewSource
    ? `${previewSource.name}${previewSource.modifiedAt ? ` · ${agoText(previewSource.modifiedAt, nowDate)}` : ''}`
    : undefined;

  return {
    id: FILES_AREA_ID,
    kind: 'files',
    data: {
      kind: 'files',
      title: 'Workspace files',
      done: false,
      current: false,
      nowSet: false,
      stepsDone: 0,
      stepsTotal: 0,
      waitingCount: 0,
      noteCount: 0,
      fileCount: grouped.pages.length + grouped.pictures.length,
      pictureCount: grouped.pictures.length,
      pageCount: grouped.pages.length,
      documentCount: grouped.documents.length,
      commitCount: 0,
      archivedCount: 0,
      pictures,
      preview,
      fresh: false,
    },
    planItems: { steps: [], decisions: [] },
    documents: [],
    repos: [],
    cards: [],
    archivedCount: 0,
    allMemberNodeIds: [
      ...grouped.documents.map((f) => workspaceFileNodeId(f.path)),
      ...grouped.pages.map((f) => workspaceFileNodeId(f.path)),
      ...grouped.pictures.map((f) => workspaceFileNodeId(f.path)),
    ],
    workspaceFiles: grouped,
  };
}
