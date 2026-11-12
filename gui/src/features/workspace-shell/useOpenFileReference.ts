import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { apiFetch } from '../../lib/api/client.js';
import { parseFileReference } from '../../lib/fileReference.js';
import { chatLayout } from '../chat/chatLayout.js';
import { browserPath, goToWorkspace, parseWorkspacePath } from '../chat/chatRoute.js';
import { isWebOrDomain, normalizeWebUrl } from '../terminal/webLinks.js';
import { closeCodeWindow, codeRequests, documentRequests, invalidateReferenceIntent, openCodeWindow, referenceIntentIsCurrent, type ReferenceTarget } from './openRequests.js';

export interface FileReferenceClick {
  path: string;
  line?: number;
  /** Only use when the current directory is known, not merely the launch directory. */
  cwd?: string;
  /** A document keeps its reader/trail while resolving, then follows reader targets in place. */
  onReader?: (target: ReferenceTarget, intent: number) => void;
}
type Resolution =
  | { status: 'found'; target: ReferenceTarget }
  | { status: 'ambiguous'; candidates: ReferenceTarget[]; truncated: boolean }
  | { status: 'not-found'; reason: 'missing' | 'directory' | 'outside-roots' };

/** Route the server's explicit identity without guessing its origin from a path. */
export function openReferenceTarget(workspace: string, target: ReferenceTarget, line: number | undefined, opener: HTMLElement | null, navigate?: NavigateFunction, navigated = false): number {
  const intent = invalidateReferenceIntent();
  if (!line && target.viewer === 'reader') {
    closeCodeWindow(workspace, opener);
    chatLayout.setHidden(false);
    documentRequests.open(workspace, { name: target.file, opener, intent, ...(target.origin.kind === 'repository' ? { repo: { name: target.origin.repoName, path: target.origin.repoPath } } : {}) });
    if (navigate) goToWorkspace(navigate, workspace, 'board');
  } else if (target.origin.kind === 'workspace') {
    openCodeWindow(workspace, { opener, workspaceFile: { workspaceId: workspace, file: target.file, line }, navigated, preserveIntent: true });
  } else {
    openCodeWindow(workspace, { opener, file: { repoName: target.origin.repoName, repoPath: target.origin.repoPath, file: target.file, line }, navigated, preserveIntent: true });
  }
  return intent;
}

// Kept for callers; the server now resolves the origin, so these are no longer needed here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useOpenFileReference(workspace: string, _workspacePath: string, _repoPaths: readonly string[] = []) {
  const navigate = useNavigate();
  const { pathname, key: routeKey } = useLocation();
  // Only the initial move belongs to this click. Once landed, any later route is a new intent.
  const navigation = useRef<{ from: string; pending: boolean } | null>(null);
  const owned = useRef<number | null>(null);
  useEffect(() => () => {
    const initialLanding = navigation.current?.pending && parseWorkspacePath(browserPath())?.workspace === workspace;
    if (!initialLanding && owned.current !== null && referenceIntentIsCurrent(owned.current)) invalidateReferenceIntent();
  }, [workspace]);
  useEffect(() => {
    if (owned.current === null || !referenceIntentIsCurrent(owned.current)) return;
    const here = parseWorkspacePath(pathname)?.workspace;
    if (here === workspace) {
      if (navigation.current) navigation.current.pending = false;
    } else if (!(navigation.current?.pending && routeKey === navigation.current.from)) {
      invalidateReferenceIntent();
    }
  }, [pathname, routeKey, workspace]);
  return useCallback(async (click: FileReferenceClick) => {
    const held = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const parsed = parseFileReference(click.path);
    if (!parsed) return;
    // A document link was already classified as a local file by the Markdown layer; only terminal text may be a web guess.
    if (!click.onReader && isWebOrDomain(parsed.path)) {
      invalidateReferenceIntent();
      window.open(normalizeWebUrl(parsed.path), '_blank', 'noopener,noreferrer');
      return;
    }
    const line = click.line ?? parsed.line;
    const request = invalidateReferenceIntent();
    owned.current = request;
    const from = browserPath();
    const here = parseWorkspacePath(from)?.workspace;
    const elsewhere = Boolean(here && here !== workspace);
    navigation.current = { from: routeKey, pending: elsewhere };
    const isCurrent = () => {
      if (!referenceIntentIsCurrent(request)) return false;
      // This hook can unmount on its initial navigation; also check the live destination.
      if (here && parseWorkspacePath(browserPath())?.workspace !== workspace) { invalidateReferenceIntent(); return false; }
      return true;
    };
    if (elsewhere) goToWorkspace(navigate, workspace, 'board');
    if (!click.onReader) {
      codeRequests.open(workspace, { kind: 'locating', path: parsed.path, line, intent: request });
      openCodeWindow(workspace, { opener: held, navigated: elsewhere, preserveIntent: true });
    }
    try {
      const query = new URLSearchParams({ path: parsed.path, ...(click.cwd ? { cwd: click.cwd } : {}) });
      const resolution = await apiFetch<Resolution>(`/api/workspace/${encodeURIComponent(workspace)}/files/reference?${query}`);
      if (!isCurrent()) return;
      if (resolution.status === 'found') {
        if (click.onReader && !line && resolution.target.viewer === 'reader') click.onReader(resolution.target, request);
        else owned.current = openReferenceTarget(workspace, resolution.target, line, held, navigate, elsewhere);
      } else {
        if (click.onReader) openCodeWindow(workspace, { opener: held, navigated: elsewhere, preserveIntent: true });
        if (resolution.status === 'ambiguous') codeRequests.open(workspace, { kind: 'ambiguous', path: parsed.path, line, candidates: resolution.candidates, truncated: resolution.truncated, opener: held, intent: request });
        else codeRequests.open(workspace, { kind: 'not-found', path: parsed.path, line, reason: resolution.reason, intent: request });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (click.onReader) openCodeWindow(workspace, { opener: held, navigated: elsewhere, preserveIntent: true });
      codeRequests.open(workspace, { kind: 'not-found', path: parsed.path, line, intent: request, reason: 'error', message: error instanceof Error ? error.message : 'The path could not be looked up.' });
    }
  }, [navigate, workspace, routeKey]);
}
