import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import * as fsSafety from '../resources/fs-safety.js';
import { documentEditability, listRootDocuments } from './root-documents.js';
import { readSwitch } from './workspace-db-switch.js';

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
  editable: boolean;
  readOnlyReason?: string;
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

export interface BuildDocumentCatalogOptions {
  repoFolders?: readonly string[];
}

const HEAD_READ_BYTES = 4096;
const MAX_EXTRACTED_DOCS = 300;
const META_CONCURRENCY = 8;
const MAX_CACHE_ENTRIES = 2000;
const EXCERPT_MAX_CHARS = 180;

const metaCache = new Map<string, { title: string; excerpt: string }>();

export function clearDocumentCatalogCache(): void {
  metaCache.clear();
}

function cacheGet(key: string): { title: string; excerpt: string } | undefined {
  const hit = metaCache.get(key);
  if (!hit) return undefined;
  metaCache.delete(key);
  metaCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: { title: string; excerpt: string }): void {
  if (metaCache.has(key)) metaCache.delete(key);
  else if (metaCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(key, value);
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Classifies evidence folders and log/hash/patch artifacts so they can be folded
 * away by default without ever reading their file contents.
 */
export function isEvidencePath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment.toLowerCase() === 'evidence')) return true;
  const basename = segments[segments.length - 1]!.toLowerCase();
  return (
    basename.endsWith('.log')
    || basename.endsWith('.patch')
    || basename === 'frozen-tree.txt'
    || /-hashes\.txt$/.test(basename)
  );
}

/** Humanizes a file basename when no heading/title is available. */
export function humanizeDocumentFilename(filePath: string): string {
  const normalized = normalizeRelPath(filePath);
  const basename = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const spaced = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return basename;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function truncateExcerpt(text: string, maxChars = EXCERPT_MAX_CHARS): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length <= maxChars) return compact;
  const slice = compact.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(maxChars * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:\-]+$/, '').trim()}…`;
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!--[\s\S]*$/g, '');
}

function stripMarkdownFrontmatter(text: string): string {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^---[ \t]*\n/.test(clean)) return clean;
  const firstBreak = clean.indexOf('\n');
  const rest = clean.slice(firstBreak + 1);
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) return clean;
  const frontmatterBody = rest.slice(0, closeMatch.index);
  const bodyLines = frontmatterBody.split('\n').map((line) => line.trim()).filter(Boolean);
  if (
    bodyLines.length === 0
    || !/^[a-zA-Z0-9_.-]+\s*:/.test(bodyLines[0]!)
    || bodyLines.some((line) => /^#{1,6}\s/.test(line))
  ) {
    return clean;
  }
  const afterClose = rest.slice(closeMatch.index + closeMatch[0].length);
  return afterClose.replace(/^\n/, '');
}

const HTML_INLINE_TAGS =
  /<\/?(?:a|abbr|b|bdi|bdo|br|cite|code|data|del|dfn|div|em|hr|i|img|ins|kbd|mark|p|q|rp|rt|ruby|s|samp|section|small|span|strong|sub|summary|sup|time|u|var|wbr)(?:\s+[^>]*)?\/?>/gi;

function stripInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  const withPlaceholders = stripHtmlComments(text).replace(/`([^`]*)`/g, (_m, inner: string) => {
    const token = `\u0001CS${codeSpans.length}\u0002`;
    codeSpans.push(inner);
    return token;
  });
  const stripped = withPlaceholders
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, '$2')
    .replace(/\*(?=\S)(.*?\S)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.*?\S)_(?=$|[^\p{L}\p{N}_])/gu, '$1$2')
    .replace(/~~(?=\S)(.*?\S)~~/g, '$1')
    .replace(HTML_INLINE_TAGS, '');
  const restored = stripped.replace(/\u0001CS(\d+)\u0002/g, (_m, idx: string) => codeSpans[Number(idx)] ?? '');
  return restored.replace(/\s+/g, ' ').trim();
}

function extractMarkdownMetadata(filePath: string, content: string): { title: string; excerpt: string } {
  const cleaned = stripHtmlComments(stripMarkdownFrontmatter(content));
  const lines = cleaned.split('\n');
  let inFence = false;
  let fenceChar = '';
  let title = '';
  const excerptLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const char = fenceMatch[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence || !trimmed) continue;

    if (!title) {
      const h1 = /^#\s+(.+?)(?:\s+#+)?\s*$/.exec(trimmed);
      if (h1) {
        const parsed = stripInlineMarkdown(h1[1]!);
        if (parsed) {
          title = parsed;
          continue;
        }
      }
    }

    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^(?:=+|-+)\s*$/.test(trimmed)) continue;
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) continue;
    if (/^\|?[\s:-]+\|[\s|:-]*$/.test(trimmed)) continue;

    if (excerptLines.length < 2) {
      const lineBody = trimmed
        .replace(/^>\s*/, '')
        .replace(/^(?:[-*+]|\d+\.)\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '');
      const plain = stripInlineMarkdown(lineBody);
      if (plain) {
        excerptLines.push(plain);
        if (excerptLines.join(' ').length >= EXCERPT_MAX_CHARS) break;
      }
    }
  }

  return {
    title: title || humanizeDocumentFilename(filePath),
    excerpt: truncateExcerpt(excerptLines.join(' ')),
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function cleanHtmlText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMetaDescription(html: string): string {
  const metaRe = /<meta\b([^>]*)>/gi;
  for (const match of html.matchAll(metaRe)) {
    const attrs = match[1] ?? '';
    const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const attrName = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? '').toLowerCase();
    if (attrName !== 'description') continue;
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const content = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? '';
    const cleaned = decodeHtmlEntities(content).replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

function extractHtmlMetadata(filePath: string, content: string): { title: string; excerpt: string } {
  const scrubbed = stripHtmlComments(content)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(scrubbed);
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(scrubbed);
  const parsedTitle = cleanHtmlText(titleMatch?.[1] ?? '') || cleanHtmlText(h1Match?.[1] ?? '');

  let excerpt = parseMetaDescription(scrubbed);
  if (!excerpt) {
    for (const match of scrubbed.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = cleanHtmlText(match[1] ?? '');
      if (text) {
        excerpt = text;
        break;
      }
    }
  }

  return {
    title: parsedTitle || humanizeDocumentFilename(filePath),
    excerpt: truncateExcerpt(excerpt),
  };
}

function extractTextMetadata(filePath: string, content: string): { title: string; excerpt: string } {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let firstLine = '';
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed) {
      firstLine = trimmed;
      break;
    }
  }
  return {
    title: humanizeDocumentFilename(filePath),
    excerpt: truncateExcerpt(firstLine),
  };
}

export function extractDocumentMetadata(
  kind: DocumentCatalogKind,
  filePath: string,
  content: string,
): { title: string; excerpt: string } {
  if (kind === 'markdown') return extractMarkdownMetadata(filePath, content);
  if (kind === 'html') return extractHtmlMetadata(filePath, content);
  if (kind === 'text') return extractTextMetadata(filePath, content);
  return { title: humanizeDocumentFilename(filePath), excerpt: '' };
}

async function readHeadMetadata(
  root: string,
  doc: { name: string; kind: DocumentCatalogKind; size: number; modifiedAt: string },
): Promise<{ title: string; excerpt: string }> {
  const fallback = { title: humanizeDocumentFilename(doc.name), excerpt: '' };
  const target = path.join(root, ...doc.name.split('/'));
  const cacheKey = `${target}:${doc.size}:${doc.modifiedAt}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let handle: fs.FileHandle | undefined;
  try {
    await fsSafety.assertNoLinkedPathComponents(root, target);
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    await fsSafety.assertFileHandleMatchesPath(handle, target);
    await fsSafety.assertNoLinkedPathComponents(root, target);
    const bytes = await fsSafety.readFileHandleAtMost(handle, HEAD_READ_BYTES);
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (bytes.length === HEAD_READ_BYTES && text.endsWith('\uFFFD')) {
      text = text.slice(0, -1);
    }
    const meta = text.includes('\u0000')
      ? fallback
      : extractDocumentMetadata(doc.kind, doc.name, text);
    cacheSet(cacheKey, meta);
    return meta;
  } catch {
    return fallback;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function runBounded<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const count = Math.min(concurrency, items.length);
  const runners = Array.from({ length: count }, async () => {
    while (index < items.length) {
      const current = items[index++];
      if (current !== undefined) await worker(current);
    }
  });
  await Promise.all(runners);
}

function splitPath(relPath: string): { name: string; parent: string } {
  const slash = relPath.lastIndexOf('/');
  if (slash < 0) return { name: relPath, parent: '' };
  return { name: relPath.slice(slash + 1), parent: relPath.slice(0, slash) };
}

function timeMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function isWithinFolder(candidateFolder: string, targetFolder: string): boolean {
  if (!targetFolder) return true;
  return candidateFolder === targetFolder || candidateFolder.startsWith(`${targetFolder}/`);
}

export async function buildDocumentCatalog(
  root: string,
  options: BuildDocumentCatalogOptions = {},
): Promise<DocumentCatalog> {
  const repoFolders = (options.repoFolders ?? []).map(normalizeRelPath).filter(Boolean);
  const inRepository = (rel: string) =>
    repoFolders.some((repoFolder) => rel === repoFolder || rel.startsWith(`${repoFolder}/`));

  const listing = await listRootDocuments(root, '', true, {
    repoFolders,
    leaveOut: repoFolders,
  });

  const rawDocs = listing.documents.filter((doc) => !inRepository(doc.name));
  const folderSet = new Set(listing.folders.filter((folder) => !inRepository(folder)));

  const metaByPath = new Map<string, { title: string; excerpt: string }>();
  const textCandidates = rawDocs
    .filter((doc) => {
      if (isEvidencePath(doc.name)) return false;
      return doc.kind === 'markdown' || doc.kind === 'text' || doc.kind === 'html';
    })
    .sort((a, b) => timeMs(b.modifiedAt) - timeMs(a.modifiedAt) || a.name.localeCompare(b.name))
    .slice(0, MAX_EXTRACTED_DOCS);

  await runBounded(textCandidates, META_CONCURRENCY, async (doc) => {
    metaByPath.set(doc.name, await readHeadMetadata(root, doc));
  });

  const switchedToDb = readSwitch(root) !== null;
  const items: DocumentCatalogItem[] = rawDocs.map((doc) => {
    const { name, parent: folder } = splitPath(doc.name);
    const evidence = isEvidencePath(doc.name);
    const meta = !evidence ? metaByPath.get(doc.name) : undefined;
    const editability = documentEditability(root, doc.name, { switchedToDb });
    return {
      path: doc.name,
      name,
      folder,
      kind: doc.kind,
      size: doc.size,
      modifiedAt: doc.modifiedAt,
      title: meta?.title ?? humanizeDocumentFilename(doc.name),
      excerpt: meta?.excerpt ?? '',
      evidence,
      editable: editability.editable,
      ...(editability.readOnlyReason ? { readOnlyReason: editability.readOnlyReason } : {}),
    };
  });

  const folderPaths = [...folderSet].sort((a, b) => a.localeCompare(b));
  type PreliminaryFolder = {
    path: string;
    name: string;
    parent: string;
    evidence: boolean;
    summary: string;
    docCount: number;
    pictureCount: number;
    evidenceCount: number;
  };
  const preliminaryByPath = new Map<string, PreliminaryFolder>();
  const zeroCountFolders: PreliminaryFolder[] = [];

  for (const folderPath of folderPaths) {
    const { name, parent } = splitPath(folderPath);
    let evidence = isEvidencePath(folderPath);
    let docCount = 0;
    let pictureCount = 0;
    let evidenceCount = 0;
    let readmeExcerpt = '';
    let fallbackReadmeExcerpt = '';

    for (const item of items) {
      if (!isWithinFolder(item.folder, folderPath)) continue;
      if (item.evidence) {
        evidenceCount += 1;
      } else if (item.kind === 'image') {
        pictureCount += 1;
      } else {
        docCount += 1;
      }

      if (!evidence && !item.evidence && item.folder === folderPath) {
        if (item.name === 'README.md' && item.excerpt) readmeExcerpt = item.excerpt;
        else if (!fallbackReadmeExcerpt && item.name.toLowerCase() === 'readme.md' && item.excerpt) {
          fallbackReadmeExcerpt = item.excerpt;
        }
      }
    }

    if (docCount + pictureCount + evidenceCount === 0) {
      if (!evidence) {
        zeroCountFolders.push({
          path: folderPath,
          name,
          parent,
          evidence: false,
          summary: '',
          docCount: 0,
          pictureCount: 0,
          evidenceCount: 0,
        });
      }
      continue;
    }
    // Folders that hold only evidence/log artifacts fold alongside evidence
    if (!evidence && docCount === 0 && pictureCount === 0 && evidenceCount > 0) {
      evidence = true;
    }

    preliminaryByPath.set(folderPath, {
      path: folderPath,
      name,
      parent,
      evidence,
      summary: evidence ? '' : (readmeExcerpt || fallbackReadmeExcerpt),
      docCount,
      pictureCount,
      evidenceCount,
    });
  }

  // Include genuinely empty folders (e.g. newly created via createRootFolder) and parents that only hold empty visible
  // subfolders, while continuing to skip folders holding uncataloged files/scripts/symlinks (bin/, scratch/, scripts/).
  zeroCountFolders.sort((a, b) => b.path.split('/').length - a.path.split('/').length || a.path.localeCompare(b.path));
  for (const candidate of zeroCountFolders) {
    const targetDir = path.join(root, ...candidate.path.split('/'));
    try {
      await fsSafety.assertNoLinkedPathComponents(root, targetDir);
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const onlyEmptyVisibleSubdirs = entries.every((entry) => {
        if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
        const childPath = `${candidate.path}/${entry.name}`;
        const child = preliminaryByPath.get(childPath);
        return Boolean(child && !child.evidence);
      });
      if (onlyEmptyVisibleSubdirs) {
        preliminaryByPath.set(candidate.path, candidate);
      }
    } catch {
      // Ignore unreadable or disappearing directories
    }
  }

  const preliminaryFolders = folderPaths
    .map((folderPath) => preliminaryByPath.get(folderPath))
    .filter((entry): entry is PreliminaryFolder => entry !== undefined);

  const visibleNonEvidenceFolders = preliminaryFolders.filter((entry) => !entry.evidence);
  const folders: DocumentCatalogFolder[] = preliminaryFolders.map((entry) => {
    let folderCount = 0;
    for (const candidate of visibleNonEvidenceFolders) {
      if (candidate.parent === entry.path) folderCount += 1;
    }
    return {
      path: entry.path,
      name: entry.name,
      parent: entry.parent,
      evidence: entry.evidence,
      summary: entry.summary,
      folderCount,
      docCount: entry.docCount,
      pictureCount: entry.pictureCount,
      evidenceCount: entry.evidenceCount,
    };
  });

  const recent = items
    .filter(
      (item) =>
        !item.evidence
        && (item.kind === 'markdown' || item.kind === 'text' || item.kind === 'html' || item.kind === 'pdf'),
    )
    .sort((a, b) => timeMs(b.modifiedAt) - timeMs(a.modifiedAt) || a.path.localeCompare(b.path))
    .slice(0, 6)
    .map((item) => item.path);

  return { items, folders, recent };
}
