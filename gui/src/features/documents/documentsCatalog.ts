import type { KindLabelKind } from '../../design/index.js';

export type DocumentCatalogKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'download';

export interface DocumentCatalogItem {
  path: string;
  name: string;
  folder: string;
  kind: DocumentCatalogKind;
  size: number;
  modifiedAt: string;
  title: string;
  excerpt: string;
  evidence: boolean;
}

export interface DocumentCatalogFolder {
  path: string;
  name: string;
  parent: string;
  evidence: boolean;
  summary: string;
  folderCount: number;
  docCount: number;
  pictureCount: number;
  evidenceCount: number;
}

export interface DocumentCatalog {
  items: DocumentCatalogItem[];
  folders: DocumentCatalogFolder[];
  recent: string[];
}

export interface BreadcrumbSegment {
  path: string;
  label: string;
}

export interface EvidenceSummary {
  totalCount: number;
  folders: DocumentCatalogFolder[];
  files: DocumentCatalogItem[];
}

/** Shares the `['workspace-files', workspaceId]` prefix so `liveFeedHub` SSE `files` invalidations refresh it automatically. */
export const documentCatalogKey = (workspaceId: string | null) => ['workspace-files', workspaceId, 'catalog'] as const;

const VALID_KINDS = new Set<DocumentCatalogKind>(['markdown', 'text', 'html', 'pdf', 'image', 'download']);

export function normalizeCatalogPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function cleanDocumentCatalog(raw: unknown): DocumentCatalog {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Partial<DocumentCatalog>;
  const items: DocumentCatalogItem[] = [];
  if (Array.isArray(data.items)) {
    for (const entry of data.items) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
      const path = normalizeCatalogPath(entry.path);
      if (!path) continue;
      const slash = path.lastIndexOf('/');
      const kind: DocumentCatalogKind = VALID_KINDS.has(entry.kind as DocumentCatalogKind)
        ? (entry.kind as DocumentCatalogKind)
        : 'download';
      items.push({
        path,
        name: typeof entry.name === 'string' && entry.name ? entry.name : (slash < 0 ? path : path.slice(slash + 1)),
        folder: typeof entry.folder === 'string' ? normalizeCatalogPath(entry.folder) : (slash < 0 ? '' : path.slice(0, slash)),
        kind,
        size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
        modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : '',
        title: typeof entry.title === 'string' && entry.title ? entry.title : (slash < 0 ? path : path.slice(slash + 1)),
        excerpt: typeof entry.excerpt === 'string' ? entry.excerpt : '',
        evidence: Boolean(entry.evidence),
      });
    }
  }

  const folders: DocumentCatalogFolder[] = [];
  if (Array.isArray(data.folders)) {
    for (const entry of data.folders) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
      const path = normalizeCatalogPath(entry.path);
      if (!path) continue;
      const slash = path.lastIndexOf('/');
      folders.push({
        path,
        name: typeof entry.name === 'string' && entry.name ? entry.name : (slash < 0 ? path : path.slice(slash + 1)),
        parent: typeof entry.parent === 'string' ? normalizeCatalogPath(entry.parent) : (slash < 0 ? '' : path.slice(0, slash)),
        evidence: Boolean(entry.evidence),
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        folderCount: typeof entry.folderCount === 'number' && Number.isFinite(entry.folderCount) ? entry.folderCount : 0,
        docCount: typeof entry.docCount === 'number' && Number.isFinite(entry.docCount) ? entry.docCount : 0,
        pictureCount: typeof entry.pictureCount === 'number' && Number.isFinite(entry.pictureCount) ? entry.pictureCount : 0,
        evidenceCount: typeof entry.evidenceCount === 'number' && Number.isFinite(entry.evidenceCount) ? entry.evidenceCount : 0,
      });
    }
  }

  const recent = Array.isArray(data.recent)
    ? data.recent.filter((p): p is string => typeof p === 'string').map(normalizeCatalogPath).filter(Boolean)
    : [];

  return { items, folders, recent };
}

export function buildBreadcrumbs(folderPath: string): BreadcrumbSegment[] {
  const normalized = normalizeCatalogPath(folderPath);
  const crumbs: BreadcrumbSegment[] = [{ path: '', label: 'All folders' }];
  if (!normalized) return crumbs;
  const parts = normalized.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ path: acc, label: part });
  }
  return crumbs;
}

function isWithinFolder(candidateFolder: string, targetFolder: string): boolean {
  if (!targetFolder) return true;
  return candidateFolder === targetFolder || candidateFolder.startsWith(`${targetFolder}/`);
}

function timeMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function sortNewestFirst(a: DocumentCatalogItem, b: DocumentCatalogItem): number {
  const diff = timeMs(b.modifiedAt) - timeMs(a.modifiedAt);
  return diff !== 0 ? diff : a.path.localeCompare(b.path);
}

export function isFolderEvidence(catalog: DocumentCatalog, folderPath: string): boolean {
  const normalized = normalizeCatalogPath(folderPath);
  if (!normalized) return false;
  return catalog.folders.some((f) => f.path === normalized && f.evidence);
}

export function childFolders(
  catalog: DocumentCatalog,
  folderPath: string,
  options: { includeEvidence?: boolean } = {},
): DocumentCatalogFolder[] {
  const normalized = normalizeCatalogPath(folderPath);
  const insideEvidence = isFolderEvidence(catalog, normalized);
  const showEvidence = Boolean(options.includeEvidence) || insideEvidence;
  return catalog.folders
    .filter((folder) => folder.parent === normalized && (showEvidence || !folder.evidence))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function folderItems(
  catalog: DocumentCatalog,
  folderPath: string,
  options: { includeEvidence?: boolean } = {},
): { documents: DocumentCatalogItem[]; pictures: DocumentCatalogItem[] } {
  const normalized = normalizeCatalogPath(folderPath);
  const insideEvidence = isFolderEvidence(catalog, normalized);
  const showEvidence = Boolean(options.includeEvidence) || insideEvidence;
  const documents: DocumentCatalogItem[] = [];
  const pictures: DocumentCatalogItem[] = [];

  for (const item of catalog.items) {
    if (item.folder !== normalized) continue;
    if (!showEvidence && item.evidence) continue;
    if (item.kind === 'image') pictures.push(item);
    else documents.push(item);
  }

  documents.sort(sortNewestFirst);
  pictures.sort(sortNewestFirst);
  return { documents, pictures };
}

export function directEvidenceSummary(catalog: DocumentCatalog, folderPath: string): EvidenceSummary {
  const normalized = normalizeCatalogPath(folderPath);
  if (isFolderEvidence(catalog, normalized)) {
    return { totalCount: 0, folders: [], files: [] };
  }

  const folders = catalog.folders
    .filter((folder) => folder.parent === normalized && folder.evidence)
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = catalog.items
    .filter((item) => item.folder === normalized && item.evidence)
    .sort(sortNewestFirst);

  const folderTotal = folders.reduce((sum, folder) => {
    if (folder.evidenceCount > 0) return sum + folder.evidenceCount;
    return sum + catalog.items.filter((item) => item.evidence && isWithinFolder(item.folder, folder.path)).length;
  }, 0);

  return {
    totalCount: folderTotal + files.length,
    folders,
    files,
  };
}

export function computeRecursiveFolderCounts(
  items: readonly DocumentCatalogItem[],
  folders: readonly DocumentCatalogFolder[],
  folderPath: string,
): Pick<DocumentCatalogFolder, 'folderCount' | 'docCount' | 'pictureCount' | 'evidenceCount'> {
  const normalized = normalizeCatalogPath(folderPath);
  let folderCount = 0;
  for (const folder of folders) {
    if (!folder.evidence && folder.parent === normalized) folderCount += 1;
  }

  let docCount = 0;
  let pictureCount = 0;
  let evidenceCount = 0;
  for (const item of items) {
    if (!isWithinFolder(item.folder, normalized)) continue;
    if (item.evidence) evidenceCount += 1;
    else if (item.kind === 'image') pictureCount += 1;
    else docCount += 1;
  }

  return { folderCount, docCount, pictureCount, evidenceCount };
}

export function formatFolderCounts(
  counts: Pick<DocumentCatalogFolder, 'folderCount' | 'docCount' | 'pictureCount' | 'evidenceCount'>,
  options: { evidence?: boolean } = {},
): string {
  if (options.evidence) {
    const n = counts.evidenceCount;
    return n > 0 ? `${n} ${n === 1 ? 'file' : 'files'}` : '';
  }
  const parts: string[] = [];
  if (counts.folderCount > 0) parts.push(`${counts.folderCount} ${counts.folderCount === 1 ? 'folder' : 'folders'}`);
  if (counts.docCount > 0) parts.push(`${counts.docCount} ${counts.docCount === 1 ? 'document' : 'documents'}`);
  if (counts.pictureCount > 0) parts.push(`${counts.pictureCount} ${counts.pictureCount === 1 ? 'picture' : 'pictures'}`);
  return parts.join(' · ');
}

export function changedLatelyItems(catalog: DocumentCatalog, limit = 4): DocumentCatalogItem[] {
  const byPath = new Map<string, DocumentCatalogItem>();
  for (const item of catalog.items) byPath.set(item.path, item);

  const picked: DocumentCatalogItem[] = [];
  const seen = new Set<string>();
  for (const recentPath of catalog.recent) {
    const item = byPath.get(recentPath);
    if (item && !item.evidence && item.kind !== 'image' && !seen.has(item.path)) {
      picked.push(item);
      seen.add(item.path);
      if (picked.length >= limit) return picked;
    }
  }

  const fallback = catalog.items
    .filter((item) => !item.evidence && item.kind !== 'image' && !seen.has(item.path))
    .sort(sortNewestFirst);
  for (const item of fallback) {
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function searchCatalog(
  catalog: DocumentCatalog,
  query: string,
  options: { includeEvidence?: boolean } = {},
): DocumentCatalogItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const terms = trimmed.split(/\s+/).filter(Boolean);
  const includeEvidence = Boolean(options.includeEvidence);

  const matches: Array<{ item: DocumentCatalogItem; titleHit: boolean }> = [];
  for (const item of catalog.items) {
    if (!includeEvidence && item.evidence) continue;
    const titleLower = item.title.toLowerCase();
    const haystack = `${titleLower}\n${item.excerpt.toLowerCase()}\n${item.path.toLowerCase()}`;
    if (!terms.every((term) => haystack.includes(term))) continue;
    const titleHit = terms.every((term) => titleLower.includes(term));
    matches.push({ item, titleHit });
  }

  matches.sort((a, b) => {
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
    return sortNewestFirst(a.item, b.item);
  });

  return matches.map((entry) => entry.item);
}

export function kindLabelFor(kind: DocumentCatalogKind): KindLabelKind {
  if (kind === 'markdown') return 'markdown';
  if (kind === 'html') return 'html';
  if (kind === 'pdf') return 'pdf';
  if (kind === 'image') return 'picture';
  return 'other';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function inferKindFromPath(filePath: string): DocumentCatalogKind {
  const lower = filePath.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'].includes(ext)) return 'download';
  return 'text';
}
