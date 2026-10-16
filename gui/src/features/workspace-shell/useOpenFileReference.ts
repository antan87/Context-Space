import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../lib/api/client.js';
import { parseFileReference } from '../../lib/fileReference.js';
import { goToWorkspace } from '../chat/chatRoute.js';
import { isUnreadableDocument, workspaceDocumentName } from '../terminal/documentReference.js';
import { isWebOrDomain, normalizeWebUrl } from '../terminal/webLinks.js';
import { codeRequests, documentRequests, type CodeRequest, type RepoFile } from './openRequests.js';

/** A path someone clicked: in terminal output, a progress card or a document. */
export interface FileReferenceClick {
  path: string;
  line?: number;
  /** The directory the terminal session runs in, so a relative path resolves the way the CLI meant it. */
  cwd?: string;
}

type Resolution =
  | ({ status: 'found' } & RepoFile)
  | { status: 'ambiguous'; candidates: RepoFile[] }
  | { status: 'not-found'; reason: 'missing' | 'directory' | 'outside-repositories'; absolutePath?: string };

/** The Code section's answer to what the server found for a path. */
export function codeRequestFor(path: string, line: number | undefined, resolution: Resolution): CodeRequest {
  if (resolution.status === 'found') {
    return { kind: 'file', repoName: resolution.repoName, repoPath: resolution.repoPath, file: resolution.file, line };
  }
  if (resolution.status === 'ambiguous') return { kind: 'ambiguous', path, line, candidates: resolution.candidates };
  return { kind: 'not-found', path, line, reason: resolution.reason, absolutePath: resolution.absolutePath };
}

/**
 * Opens a clicked path where it belongs: a web address in the browser, a workspace document in
 * Docs, anything else in the Code section beside the chat. Every click ends somewhere visible:
 * Code first says it is locating the path, then shows the file, the files the path could mean,
 * or why there is none, instead of the click silently doing nothing.
 */
export function useOpenFileReference(workspace: string, workspacePath: string, repoPaths: readonly string[] = []) {
  const navigate = useNavigate();
  const latest = useRef(0);

  return useCallback(async (click: FileReferenceClick) => {
    const parsed = parseFileReference(click.path);
    if (!parsed) return;
    if (isWebOrDomain(parsed.path)) {
      window.open(normalizeWebUrl(parsed.path), '_blank', 'noopener,noreferrer');
      return;
    }
    const line = click.line ?? parsed.line;
    const request = ++latest.current;
    const base = `/api/workspace/${encodeURIComponent(workspace)}`;

    const name = workspaceDocumentName({ path: parsed.path, line }, workspacePath, [...repoPaths], click.cwd);
    if (name) {
      let isDocument: boolean;
      try {
        // Documents in folders are not in the root listing, so the server is asked to open them.
        isDocument = name.includes('/')
          ? await apiFetch(`${base}/documents/preview?name=${encodeURIComponent(name)}`).then(() => true)
          : (await apiFetch<{ documents: { name: string }[] }>(`${base}/documents`)).documents.some((document) => document.name === name);
      } catch (error) {
        // A nested file the server found but cannot preview still opens in Docs, which says why.
        isDocument = name.includes('/') && isUnreadableDocument(error);
      }
      if (request !== latest.current) return;
      if (isDocument) {
        documentRequests.open(workspace, { name });
        goToWorkspace(navigate, workspace, 'documents');
        return;
      }
    }

    codeRequests.open(workspace, { kind: 'locating', path: parsed.path, line });
    goToWorkspace(navigate, workspace, 'changes');
    try {
      const query = new URLSearchParams({ path: parsed.path, ...(click.cwd ? { cwd: click.cwd } : {}) });
      const resolution = await apiFetch<Resolution>(`${base}/files/resolve?${query}`);
      if (request !== latest.current) return;
      codeRequests.open(workspace, codeRequestFor(parsed.path, line, resolution));
    } catch (error) {
      if (request !== latest.current) return;
      codeRequests.open(workspace, {
        kind: 'not-found', path: parsed.path, line, reason: 'error',
        message: error instanceof Error ? error.message : 'The path could not be looked up.',
      });
    }
  }, [navigate, workspace, workspacePath, repoPaths]);
}
