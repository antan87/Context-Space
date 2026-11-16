import { splitLocation } from '../lib/fileReference.js';

/**
 * Decides what a link inside rendered markdown may do. A raw `<a href>` is
 * never emitted for local paths: the app is a single page served from `/`, so
 * a file path such as `/home/me/workspace/shot.png` or `notes/a.md` resolves
 * against the app's own origin and replaces the whole app with a 404.
 */
export type MarkdownLinkTarget =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; href: string }
  | { kind: 'workspace-file'; path: string; line?: number }
  | { kind: 'inert'; label: string };

export interface MarkdownLinkContext {
  /** Board reader can resolve authoritative absolute/source-alias and home paths on the server. */
  resolveReferences?: boolean;
  /** Absolute workspace folder; absolute links inside it open in the app. */
  workspaceRoot?: string;
  /** Workspace-relative path (with `/`) of the document being rendered. */
  documentPath?: string;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function stripQueryAndFragment(value: string) {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function toSlashes(value: string) {
  return value.replace(/\\/g, '/');
}

function isAbsolutePath(value: string) {
  return value.startsWith('/') || WINDOWS_DRIVE.test(value);
}

/** Resolves `.`/`..` segments; returns null when the path climbs above the root. */
function normalizeRelative(segments: string[]): string | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length ? out.join('/') : null;
}

function withinRoot(absolute: string, root: string): string | null {
  const normalizedRoot = toSlashes(root).replace(/\/+$/, '');
  if (!normalizedRoot) return null;
  // Windows paths compare case-insensitively; POSIX paths do not.
  const windows = WINDOWS_DRIVE.test(normalizedRoot + '/');
  const candidate = windows ? absolute.toLowerCase() : absolute;
  const prefix = (windows ? normalizedRoot.toLowerCase() : normalizedRoot) + '/';
  if (!candidate.startsWith(prefix)) return null;
  return normalizeRelative(absolute.slice(prefix.length).split('/'));
}

/**
 * Workspace-relative path (with `/`) for a relative or absolute file path, or
 * null when it is outside the workspace or names nothing. Accepts `\` separators
 * and compares Windows roots case-insensitively.
 */
export function toWorkspaceRelative(rawPath: string, workspaceRoot?: string): string | null {
  const target = toSlashes(rawPath.trim());
  if (isAbsolutePath(target)) return workspaceRoot ? withinRoot(target, workspaceRoot) : null;
  return normalizeRelative(target.split('/'));
}

export function classifyMarkdownLink(rawHref: string | undefined | null, context?: MarkdownLinkContext): MarkdownLinkTarget {
  const href = (rawHref ?? '').trim();
  if (!href) return { kind: 'inert', label: '' };
  if (href.startsWith('#')) return { kind: 'anchor', id: decode(href.slice(1)) };
  if (href.startsWith('//')) return { kind: 'inert', label: href };

  // Encoded schemes are literal filenames, including a trailing `(1)`; never reinterpret their spelling.
  const encodedScheme = !SCHEME.test(href) && SCHEME.test(decode(href)) && !WINDOWS_DRIVE.test(decode(href));
  const location = encodedScheme ? { path: href } : splitLocation(href);
  let localPath = location.path;
  const scheme = WINDOWS_DRIVE.test(localPath) ? null : SCHEME.exec(localPath)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
      try {
        const url = new URL(href);
        if ((scheme === 'mailto' || url.hostname) && !url.username && !url.password) return { kind: 'external', href: url.href };
      } catch { /* fall through */ }
      return { kind: 'inert', label: href };
    }
    if (scheme !== 'file') return { kind: 'inert', label: href };
    try {
      localPath = decode(new URL(localPath).pathname).replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      return { kind: 'inert', label: href };
    }
  }

  const label = decode(stripQueryAndFragment(localPath));
  if (!context) return { kind: 'inert', label };
  const target = toSlashes(label);

  if (context.resolveReferences && (target.startsWith('~') || (isAbsolutePath(target) && !toWorkspaceRelative(target, context.workspaceRoot)))) {
    return { kind: 'workspace-file', path: target, ...(location.line ? { line: location.line } : {}) };
  }

  const documentDir = (context.documentPath ?? '').split('/').slice(0, -1);
  const relative = isAbsolutePath(target)
    ? toWorkspaceRelative(target, context.workspaceRoot)
    : normalizeRelative([...documentDir, ...target.split('/')]);
  return relative ? { kind: 'workspace-file', path: relative, ...(location.line ? { line: location.line } : {}) } : { kind: 'inert', label };
}

/** GitHub-style heading slug so in-document `#anchor` links have a target. */
export function headingSlug(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
